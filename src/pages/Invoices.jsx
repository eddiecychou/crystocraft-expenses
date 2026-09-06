import { useState, useEffect, useRef } from 'react'
import { collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { CURRENCIES } from '../constants'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import ConfirmDialog from '../components/ConfirmDialog'
import { parseCSV } from '../lib/paymentMatching'
import { mapDocumentCsvRecords, uploadDocumentFile } from '../lib/documentImport'
import { DocumentIcon, AttachIcon, ICON_STROKE_WIDTH } from '../icons'

// Phase 1: import, review, store, and list customer invoices (income) and
// supplier purchase orders (expense-side commitments) via CSV or PDF/image.
// No reconciliation against bank transactions yet — that's Phase 2, once
// this data model is proven against real documents. See LESSONS_LEARNED.md
// for why PDF extraction here goes through the OCR+Gemini pipeline
// (process-invoice.js) rather than a positional parser like
// pdfStatementParser.js: these come from many different customers/
// suppliers, each with their own arbitrary layout, unlike a bank
// statement where one issuer means one fixed template.
const TABS = [
  { kind: 'invoice', label: 'Income Invoices', collection: 'salesInvoices', counterpartyLabel: 'Customer', numberLabel: 'Invoice #' },
  { kind: 'po', label: 'Supplier POs', collection: 'purchaseOrders', counterpartyLabel: 'Supplier', numberLabel: 'PO #' },
]

export default function Invoices() {
  const { activeProject } = useProject()
  const [activeKind, setActiveKind] = useState('invoice')
  const tab = TABS.find(t => t.kind === activeKind)

  const [records, setRecords] = useState([])
  const [fileItems, setFileItems] = useState([])
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [processDone, setProcessDone] = useState(0)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState(null)
  const fileRef = useRef()
  const resultIdRef = useRef(0)
  const fileIdRef = useRef(0)

  useEffect(() => {
    if (!activeProject) { setRecords([]); return }
    const q = query(collection(db, tab.collection), where('projectId', '==', activeProject.id))
    return onSnapshot(q, snap => {
      setRecords(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date || '').localeCompare(a.date || '')))
    })
  }, [activeProject, tab.collection])

  function switchTab(kind) {
    setActiveKind(kind)
    setFileItems([]); setResults([]); setMessage(''); setEditingId(null)
  }

  async function readFiles(rawFiles) {
    setLoading(true)
    const items = []
    for (const file of rawFiles) {
      const isCsv = file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv'
      if (isCsv) {
        items.push({ _id: ++fileIdRef.current, name: file.name, isCsv: true, file })
        continue
      }
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
      try {
        const base64 = await toBase64(file)
        items.push({ _id: ++fileIdRef.current, name: file.name, file, base64, mimeType: isPdf ? 'application/pdf' : (file.type || 'image/jpeg') })
      } catch (err) {
        items.push({ _id: ++fileIdRef.current, name: file.name, error: err.message || 'Could not read file' })
      }
    }
    setFileItems(items)
    setLoading(false)
    await processFiles(items)
  }

  function handleDrop(e) {
    e.preventDefault()
    const dropped = Array.from(e.dataTransfer.files)
    if (dropped.length) readFiles(dropped)
  }

  function handleChange(e) {
    const selected = Array.from(e.target.files)
    if (selected.length) readFiles(selected)
  }

  async function processFiles(items) {
    setProcessing(true)
    setProcessDone(0)
    const out = []
    let done = 0
    for (const item of items) {
      setProcessDone(++done)
      if (item.error) { out.push({ fileName: item.name, error: item.error, _id: ++resultIdRef.current }); continue }
      if (item.isCsv) {
        try {
          const text = await item.file.text()
          const { headers, records: recs } = parseCSV(text)
          const mapped = mapDocumentCsvRecords(recs, headers, activeKind)
          if (!mapped.length) {
            out.push({ fileName: item.name, error: `No rows recognized — check it has ${tab.numberLabel}, ${tab.counterpartyLabel}, Date, and Amount columns.`, _id: ++resultIdRef.current })
            continue
          }
          for (const row of mapped) {
            out.push({ ...row, fileName: item.name, sourceType: 'csv', _id: ++resultIdRef.current })
          }
        } catch (err) {
          out.push({ fileName: item.name, error: err.message || 'Could not parse CSV', _id: ++resultIdRef.current })
        }
        continue
      }
      try {
        const res = await fetch('/api/process-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileData: item.base64, mimeType: item.mimeType, docKind: activeKind }),
        })
        const data = await res.json()
        out.push({ ...data, fileName: item.name, fileItem: item, sourceType: 'pdf', _id: ++resultIdRef.current })
      } catch (err) {
        out.push({ fileName: item.name, error: err.message || 'Failed to process', _id: ++resultIdRef.current })
      }
    }
    setResults(out)
    setProcessing(false)
  }

  function update(id, field, value) {
    setResults(prev => prev.map(r => r._id === id ? { ...r, [field]: value } : r))
  }

  function removeResult(id) {
    setConfirmDialog({
      onConfirm: () => {
        setResults(prev => prev.filter(r => r._id !== id))
        setConfirmDialog(null)
      }
    })
  }

  function addManual() {
    setResults(prev => [...prev, { fileName: 'Manual Entry', number: '', counterpartyName: '', date: new Date().toISOString().slice(0, 10), amount: '', currency: 'HKD', notes: '', sourceType: 'manual', _id: ++resultIdRef.current }])
  }

  async function saveAll() {
    const valid = results.filter(r => !r.error)
    if (!valid.length) return
    setSaving(true)
    const uid = auth.currentUser.uid
    const email = auth.currentUser.email

    for (const r of valid) {
      const docRef = await addDoc(collection(db, tab.collection), {
        projectId: activeProject.id,
        number: r.number || '',
        counterpartyName: r.counterpartyName || '',
        date: r.date || '',
        amount: parseFloat(r.amount) || 0,
        currency: r.currency || 'HKD',
        notes: r.notes || '',
        sourceType: r.sourceType || 'manual',
        createdAt: serverTimestamp(),
        createdBy: uid,
        createdByEmail: email,
      })

      if (r.fileItem && !r.fileItem.error) {
        try {
          const { url, path } = await uploadDocumentFile(r.fileItem.file, activeProject.id, activeKind, docRef.id)
          await updateDoc(doc(db, tab.collection, docRef.id), { sourceFileUrl: url, sourceFilePath: path })
        } catch (err) {
          console.error('Source file upload failed for', r.fileName, err)
        }
      }
    }

    setSaving(false)
    setMessage(`Saved ${valid.length} ${tab.label.toLowerCase()}.`)
    setFileItems([]); setResults([])
  }

  function startEdit(rec) {
    setEditingId(rec.id)
    setEditDraft({ number: rec.number || '', counterpartyName: rec.counterpartyName || '', date: rec.date || '', amount: rec.amount ?? '', currency: rec.currency || 'HKD', notes: rec.notes || '' })
  }

  async function saveEdit(rec) {
    await updateDoc(doc(db, tab.collection, rec.id), {
      number: editDraft.number.trim(),
      counterpartyName: editDraft.counterpartyName.trim(),
      date: editDraft.date,
      amount: parseFloat(editDraft.amount) || 0,
      currency: editDraft.currency,
      notes: editDraft.notes.trim(),
    })
    setEditingId(null)
  }

  function deleteRecord(rec) {
    setConfirmDialog({
      onConfirm: async () => {
        await deleteDoc(doc(db, tab.collection, rec.id))
        setConfirmDialog(null)
      }
    })
  }

  return (
    <div className="page">
      <ProjectBanner />
      <h2>Invoices & Purchase Orders</h2>

      <div className="tab-row" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.kind} className={`btn-small${activeKind === t.kind ? ' btn-primary' : ' btn-ghost'}`} onClick={() => switchTab(t.kind)}>
            {t.label}
          </button>
        ))}
      </div>

      {results.length === 0 && (
        <>
          <div
            className="dropzone"
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => fileRef.current.click()}
          >
            <DocumentIcon className="dropzone-icon" size={40} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <p>Drag & drop {tab.label.toLowerCase()} here, or click to select</p>
            <p className="hint">CSV, or PDF/image (scanned/photographed document) · Multiple files OK</p>
            <input ref={fileRef} type="file" multiple accept="image/*,.pdf,.csv,text/csv" onChange={handleChange} hidden />
          </div>
          <div style={{ textAlign: 'center', margin: '-8px 0 20px' }}>
            <button onClick={() => { setResults([]); addManual() }} className="btn-ghost">+ Add Manually</button>
          </div>
          {loading && <p className="hint">Reading files…</p>}
          {processing && <p className="hint">Extracting {processDone} of {fileItems.length}…</p>}
          {message && <p className="success-msg">{message}</p>}
        </>
      )}

      {results.length > 0 && (
        <div>
          <h3>Review Extracted Data</h3>
          <p className="hint">Check and correct any fields before saving.</p>
          {results.map(r => (
            <div key={r._id} className="result-card">
              <div className="result-card-header">
                <div className="result-thumb-group">
                  {r.fileItem && !r.fileItem.error && <div className="result-thumb-pdf"><DocumentIcon size={22} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" /></div>}
                  <span className="result-filename">{r.fileName}</span>
                </div>
                <button onClick={() => removeResult(r._id)} className="btn-small btn-danger">Remove</button>
              </div>
              {r.error
                ? <div className="error-msg">Could not extract: {r.error}</div>
                : (
                  <div className="result-grid">
                    <label>
                      {tab.numberLabel}
                      <input value={r.number || ''} onChange={e => update(r._id, 'number', e.target.value)} />
                    </label>
                    <label>
                      {tab.counterpartyLabel}
                      <input value={r.counterpartyName || ''} onChange={e => update(r._id, 'counterpartyName', e.target.value)} />
                    </label>
                    <label>
                      Date
                      <input type="date" value={r.date || ''} onChange={e => update(r._id, 'date', e.target.value)} />
                    </label>
                    <label>
                      Amount
                      <input type="number" inputMode="decimal" step="0.01" value={r.amount || ''} onChange={e => update(r._id, 'amount', e.target.value)} />
                    </label>
                    <label>
                      Currency
                      <select value={r.currency || 'HKD'} onChange={e => update(r._id, 'currency', e.target.value)}>
                        {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                      </select>
                    </label>
                    <label className="full-width">
                      Notes
                      <input value={r.notes || ''} onChange={e => update(r._id, 'notes', e.target.value)} />
                    </label>
                  </div>
                )
              }
            </div>
          ))}
          <div className="action-row">
            <button onClick={saveAll} disabled={saving || processing} className="btn-primary">
              {saving ? 'Saving…' : `Save All ${tab.label}`}
            </button>
            <button onClick={addManual} disabled={processing} className="btn-ghost">+ Add Manually</button>
            <button onClick={() => { setResults([]); setFileItems([]) }} className="btn-ghost">Cancel</button>
          </div>
          {confirmDialog && (
            <ConfirmDialog
              message="Remove this row?"
              confirmLabel="Remove"
              onConfirm={confirmDialog.onConfirm}
              onCancel={() => setConfirmDialog(null)}
            />
          )}
        </div>
      )}

      <h3 style={{ marginTop: 32 }}>{tab.label}</h3>
      {!records.length && <p className="hint">No {tab.label.toLowerCase()} yet.</p>}
      {!!records.length && (
        <div style={{ overflowX: 'auto' }}>
          <table className="txn-table-compact">
            <thead>
              <tr><th>Date</th><th>{tab.numberLabel}</th><th>{tab.counterpartyLabel}</th><th>Amount</th><th>Notes</th><th>Source</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {records.map(rec => editingId === rec.id ? (
                <tr key={rec.id}>
                  <td><input type="date" value={editDraft.date} onChange={e => setEditDraft({ ...editDraft, date: e.target.value })} /></td>
                  <td><input value={editDraft.number} onChange={e => setEditDraft({ ...editDraft, number: e.target.value })} /></td>
                  <td><input value={editDraft.counterpartyName} onChange={e => setEditDraft({ ...editDraft, counterpartyName: e.target.value })} /></td>
                  <td>
                    <input type="number" step="0.01" value={editDraft.amount} onChange={e => setEditDraft({ ...editDraft, amount: e.target.value })} style={{ width: 90 }} />
                    <select value={editDraft.currency} onChange={e => setEditDraft({ ...editDraft, currency: e.target.value })}>
                      {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </td>
                  <td><input value={editDraft.notes} onChange={e => setEditDraft({ ...editDraft, notes: e.target.value })} /></td>
                  <td>{rec.sourceType}</td>
                  <td>
                    <button className="btn-small btn-primary" onClick={() => saveEdit(rec)}>Save</button>
                    <button className="btn-small btn-ghost" onClick={() => setEditingId(null)}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={rec.id}>
                  <td>{rec.date}</td>
                  <td>{rec.number}</td>
                  <td>{rec.counterpartyName}</td>
                  <td data-amount="true">{rec.currency} {Number(rec.amount || 0).toFixed(2)}</td>
                  <td>{rec.notes}</td>
                  <td>
                    {rec.sourceFileUrl
                      ? <a href={rec.sourceFileUrl} target="_blank" rel="noreferrer"><AttachIcon size={14} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" /> {rec.sourceType}</a>
                      : rec.sourceType}
                  </td>
                  <td>
                    <button className="btn-small btn-ghost" onClick={() => startEdit(rec)}>Edit</button>
                    <button className="btn-small btn-danger" onClick={() => deleteRecord(rec)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

async function toBase64(file) {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}
