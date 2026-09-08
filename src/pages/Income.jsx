import { useState, useEffect, useRef } from 'react'
import { collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { CURRENCIES, INCOME_CATEGORIES } from '../constants'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import ConfirmDialog from '../components/ConfirmDialog'
import { uploadDocumentFile } from '../lib/documentImport'
import { DocumentIcon, AttachIcon, ICON_STROKE_WIDTH } from '../icons'

// Finance repositioning MVP-2: Income as a first-class FinanceRecord
// (src/lib/financeRecords.js), same level as Expense — never a negative
// expense category. Covers only what the Operation Center does NOT
// already generate a Sales Invoice for: rent income, bank interest,
// refunds, other non-order income (a customer sale WITH an OC invoice
// belongs in salesInvoices, see Invoices.jsx). Deliberately its own page,
// never merged with Invoices & POs — the spec is explicit that Income
// Upload must be an unambiguous, separate entry point.
//
// PDF/image only (no CSV) — these are scanned/photographed notices, not
// spreadsheet exports. Same OCR+Gemini pipeline as Invoices.jsx
// (process-invoice.js, docKind:'income'), never a positional parser —
// every payer has their own layout.
export default function Income() {
  const { activeProject } = useProject()
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
  // Set by linkIncome/confirmInvoiceMatch-style logic in Reconciliation.jsx
  const [statusFilter, setStatusFilter] = useState('all') // 'all' | 'outstanding' | 'received'
  const fileRef = useRef()
  const resultIdRef = useRef(0)
  const fileIdRef = useRef(0)

  useEffect(() => {
    if (!activeProject) { setRecords([]); return }
    const q = query(collection(db, 'income'), where('projectId', '==', activeProject.id))
    return onSnapshot(q, snap => {
      setRecords(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date || '').localeCompare(a.date || '')))
    })
  }, [activeProject])

  async function readFiles(rawFiles) {
    setLoading(true)
    const items = []
    for (const file of rawFiles) {
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
      try {
        const res = await fetch('/api/process-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileData: item.base64, mimeType: item.mimeType, docKind: 'income' }),
        })
        const data = await res.json()
        out.push({ ...data, category: 'Other Income', fileName: item.name, fileItem: item, sourceType: 'finance_upload', _id: ++resultIdRef.current })
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
    setResults(prev => [...prev, { fileName: 'Manual Entry', number: '', counterpartyName: '', date: new Date().toISOString().slice(0, 10), amount: '', currency: 'HKD', category: 'Other Income', notes: '', sourceType: 'manual', _id: ++resultIdRef.current }])
  }

  async function saveAll() {
    const valid = results.filter(r => !r.error)
    if (!valid.length) return
    setSaving(true)
    const uid = auth.currentUser.uid
    const email = auth.currentUser.email

    for (const r of valid) {
      const docRef = await addDoc(collection(db, 'income'), {
        projectId: activeProject.id,
        recordType: 'income',
        number: r.number || '',
        counterpartyName: r.counterpartyName || '',
        date: r.date || '',
        amount: parseFloat(r.amount) || 0,
        currency: r.currency || 'HKD',
        category: r.category || 'Other Income',
        notes: r.notes || '',
        sourceType: r.sourceType || 'manual',
        matchedPaymentTransactionId: null,
        matchedPaymentAccountId: null,
        settlementStatus: 'unsettled',
        createdAt: serverTimestamp(),
        createdBy: uid,
        createdByEmail: email,
      })

      if (r.fileItem && !r.fileItem.error) {
        try {
          const { url, path } = await uploadDocumentFile(r.fileItem.file, activeProject.id, 'income', docRef.id)
          await updateDoc(doc(db, 'income', docRef.id), { sourceFileUrl: url, sourceFilePath: path })
        } catch (err) {
          console.error('Source file upload failed for', r.fileName, err)
        }
      }
    }

    setSaving(false)
    setMessage(`Saved ${valid.length} income record${valid.length === 1 ? '' : 's'}.`)
    setFileItems([]); setResults([])
  }

  function startEdit(rec) {
    setEditingId(rec.id)
    setEditDraft({ number: rec.number || '', counterpartyName: rec.counterpartyName || '', date: rec.date || '', amount: rec.amount ?? '', currency: rec.currency || 'HKD', category: rec.category || 'Other Income', notes: rec.notes || '' })
  }

  async function saveEdit(rec) {
    await updateDoc(doc(db, 'income', rec.id), {
      number: editDraft.number.trim(),
      counterpartyName: editDraft.counterpartyName.trim(),
      date: editDraft.date,
      amount: parseFloat(editDraft.amount) || 0,
      currency: editDraft.currency,
      category: editDraft.category,
      notes: editDraft.notes.trim(),
    })
    setEditingId(null)
  }

  function deleteRecord(rec) {
    setConfirmDialog({
      onConfirm: async () => {
        await deleteDoc(doc(db, 'income', rec.id))
        setConfirmDialog(null)
      }
    })
  }

  const filteredRecords = statusFilter === 'outstanding' ? records.filter(r => r.settlementStatus !== 'confirmed')
    : statusFilter === 'received' ? records.filter(r => r.settlementStatus === 'confirmed')
    : records

  return (
    <div className="page">
      <ProjectBanner />
      <h2>Income</h2>
      <p className="hint">
        Income not already covered by an Operation Center Sales Invoice — rent, bank interest, refunds, and other non-order income.
      </p>

      {results.length === 0 && (
        <>
          <div
            className="dropzone"
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => fileRef.current.click()}
          >
            <DocumentIcon className="dropzone-icon" size={40} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <p>Drag & drop an income document here, or click to select</p>
            <p className="hint">PDF or image (rent receipt, interest notice, refund notice, etc.) · Multiple files OK</p>
            <input ref={fileRef} type="file" multiple accept="image/*,.pdf" onChange={handleChange} hidden />
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
                      Reference
                      <input value={r.number || ''} onChange={e => update(r._id, 'number', e.target.value)} />
                    </label>
                    <label>
                      Payer
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
                    <label>
                      Category
                      <select value={r.category || 'Other Income'} onChange={e => update(r._id, 'category', e.target.value)}>
                        {INCOME_CATEGORIES.map(c => <option key={c}>{c}</option>)}
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
              {saving ? 'Saving…' : 'Save All Income'}
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

      <div className="card-header" style={{ marginTop: 32 }}>
        <h3 style={{ margin: 0 }}>Income Records</h3>
        <div className="preset-btns">
          <button className={`btn-small${statusFilter === 'all' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setStatusFilter('all')}>
            All ({records.length})
          </button>
          <button className={`btn-small${statusFilter === 'outstanding' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setStatusFilter('outstanding')}>
            Outstanding ({records.filter(r => r.settlementStatus !== 'confirmed').length})
          </button>
          <button className={`btn-small${statusFilter === 'received' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setStatusFilter('received')}>
            Received ({records.filter(r => r.settlementStatus === 'confirmed').length})
          </button>
        </div>
      </div>
      {!records.length && <p className="hint">No income records yet.</p>}
      {!!records.length && (
        <div style={{ overflowX: 'auto' }}>
          {filteredRecords.length === 0 && <p className="hint">No {statusFilter} income records.</p>}
          {filteredRecords.length > 0 &&
          <table className="expense-table">
            <thead>
              <tr><th>Date</th><th>Reference</th><th>Payer</th><th>Category</th><th>Amount</th><th>Status</th><th>Notes</th><th>Source</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {filteredRecords.map(rec => editingId === rec.id ? (
                <tr key={rec.id}>
                  <td><input type="date" value={editDraft.date} onChange={e => setEditDraft({ ...editDraft, date: e.target.value })} /></td>
                  <td><input value={editDraft.number} onChange={e => setEditDraft({ ...editDraft, number: e.target.value })} /></td>
                  <td><input value={editDraft.counterpartyName} onChange={e => setEditDraft({ ...editDraft, counterpartyName: e.target.value })} /></td>
                  <td>
                    <select value={editDraft.category} onChange={e => setEditDraft({ ...editDraft, category: e.target.value })}>
                      {INCOME_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </td>
                  <td>
                    <input type="number" step="0.01" value={editDraft.amount} onChange={e => setEditDraft({ ...editDraft, amount: e.target.value })} style={{ width: 90 }} />
                    <select value={editDraft.currency} onChange={e => setEditDraft({ ...editDraft, currency: e.target.value })}>
                      {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </td>
                  <td>
                    <span className={`badge ${rec.settlementStatus === 'confirmed' ? 'badge-success' : 'badge-warning'}`}>
                      {rec.settlementStatus === 'confirmed' ? 'Received' : 'Outstanding'}
                    </span>
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
                  <td>{rec.category}</td>
                  <td data-amount="true">{rec.currency} {Number(rec.amount || 0).toFixed(2)}</td>
                  <td>
                    <span className={`badge ${rec.settlementStatus === 'confirmed' ? 'badge-success' : 'badge-warning'}`} title={rec.matchedPaymentTransactionId ? 'Matched to a bank/card transaction in Reconciliation' : 'No matching transaction yet'}>
                      {rec.settlementStatus === 'confirmed' ? 'Received' : 'Outstanding'}
                    </span>
                  </td>
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
          }
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
