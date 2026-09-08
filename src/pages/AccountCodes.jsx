import { useState, useEffect, useRef } from 'react'
import { collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc, writeBatch, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import ConfirmDialog from '../components/ConfirmDialog'
import { DEFAULT_ACCOUNT_CODES } from '../constants'
import { parseCSV } from '../lib/paymentMatching'

const TYPE_LABELS = { income: 'Income', expense: 'Expense', asset: 'Asset', liability: 'Liability', equity: 'Equity', other: 'Other' }
const TYPE_ORDER = ['income', 'expense', 'asset', 'liability', 'equity', 'other']

const CODE_ALIASES = ['code', 'account code', 'account #', 'account no', 'number']
const NAME_ALIASES = ['name', 'account name', 'description']
const TYPE_ALIASES = ['type', 'account type']

// Substring match, same pattern as findColumn in paymentMatching.js/
// documentImport.js — a real export routinely differs from a bare alias
// by a trailing word or punctuation.
function findColumn(headers, aliases) {
  const lower = headers.map(h => h.toLowerCase())
  for (const alias of aliases) {
    const i = lower.findIndex(h => h === alias || h.includes(alias))
    if (i !== -1) return headers[i]
  }
  return null
}

// Finance repositioning MVP-3: a real per-project chart of accounts,
// added ALONGSIDE category/paymentMethod (Upload.jsx/Income.jsx/
// Expenses.jsx keep their existing Category field unchanged — this is
// optional, not a replacement, per explicit confirmation). No hard
// delete for a code — deactivate only, so historical records that used
// it keep displaying correctly (spec §7).
export default function AccountCodes() {
  const { activeProject } = useProject()
  const [codes, setCodes] = useState([])
  const [rules, setRules] = useState([])
  const [typeFilter, setTypeFilter] = useState('all')
  const [newCode, setNewCode] = useState({ code: '', name: '', type: 'expense' })
  const [adding, setAdding] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const [confirmDialog, setConfirmDialog] = useState(null)
  const csvRef = useRef()

  useEffect(() => {
    if (!activeProject) return
    const unsubC = onSnapshot(
      query(collection(db, 'accountCodes'), where('projectId', '==', activeProject.id)),
      snap => setCodes(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.code.localeCompare(b.code)))
    )
    const unsubR = onSnapshot(
      query(collection(db, 'accountCodeRules'), where('projectId', '==', activeProject.id)),
      snap => setRules(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.merchantLabel || '').localeCompare(b.merchantLabel || '')))
    )
    return () => { unsubC(); unsubR() }
  }, [activeProject?.id])

  // Seeds the starter chart as real, editable docs — shown as a deliberate
  // button on the empty state, not a silent background migration, so an
  // existing project (this one) sees it happen rather than finding new
  // data appear unexplained.
  async function loadStarterChart() {
    setSeeding(true)
    const batch = writeBatch(db)
    for (const c of DEFAULT_ACCOUNT_CODES) {
      batch.set(doc(collection(db, 'accountCodes')), {
        projectId: activeProject.id,
        code: c.code,
        name: c.name,
        type: c.type,
        active: true,
        source: 'default',
        description: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    }
    await batch.commit()
    setSeeding(false)
  }

  async function addCode() {
    if (!newCode.code.trim() || !newCode.name.trim()) return
    setAdding(true)
    await addDoc(collection(db, 'accountCodes'), {
      projectId: activeProject.id,
      code: newCode.code.trim(),
      name: newCode.name.trim(),
      type: newCode.type,
      active: true,
      source: 'company',
      description: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    setNewCode({ code: '', name: '', type: 'expense' })
    setAdding(false)
  }

  // Bulk alternative to adding codes one at a time — for a company with an
  // existing chart of accounts already in a spreadsheet. Expects Code/Name
  // columns and an optional Type (defaults to 'expense' when missing or
  // unrecognized, since a downloaded chart is more often expense-heavy).
  // Skips a row whose code already exists in this project rather than
  // creating a duplicate or silently overwriting the existing one.
  async function handleCsvImport(e) {
    const file = e.target.files?.[0]
    if (!file || !activeProject) return
    setImporting(true)
    setImportMessage('')
    try {
      const text = await file.text()
      const { headers, records } = parseCSV(text)
      const codeCol = findColumn(headers, CODE_ALIASES)
      const nameCol = findColumn(headers, NAME_ALIASES)
      const typeCol = findColumn(headers, TYPE_ALIASES)
      if (!codeCol || !nameCol) {
        setImportMessage(`Could not find Code and Name columns in "${file.name}".`)
        setImporting(false)
        if (csvRef.current) csvRef.current.value = ''
        return
      }
      const existing = new Set(codes.map(c => c.code))
      const seenInFile = new Set()
      let created = 0, skipped = 0
      const batch = writeBatch(db)
      for (const rec of records) {
        const code = (rec[codeCol] || '').trim()
        const name = (rec[nameCol] || '').trim()
        if (!code || !name) continue
        if (existing.has(code) || seenInFile.has(code)) { skipped++; continue }
        seenInFile.add(code)
        const rawType = (typeCol ? rec[typeCol] : '').trim().toLowerCase()
        const type = TYPE_ORDER.includes(rawType) ? rawType : 'expense'
        batch.set(doc(collection(db, 'accountCodes')), {
          projectId: activeProject.id,
          code, name, type,
          active: true,
          source: 'company',
          description: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
        created++
      }
      if (created > 0) await batch.commit()
      setImportMessage(`Imported ${created} code${created === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already existing` : ''}.`)
    } catch (err) {
      setImportMessage(`Import failed: ${err.message || 'could not read file'}`)
    }
    setImporting(false)
    if (csvRef.current) csvRef.current.value = ''
  }

  async function toggleActive(c) {
    await updateDoc(doc(db, 'accountCodes', c.id), { active: !c.active, updatedAt: serverTimestamp() })
  }

  function deleteRule(rule) {
    setConfirmDialog({
      message: <>Delete the account-code rule for <strong>{rule.merchantLabel || rule.merchantKey}</strong>? Records that already used it keep their code — only future suggestions stop.</>,
      confirmLabel: 'Delete Rule',
      confirmClassName: 'btn-danger',
      onConfirm: async () => { await deleteDoc(doc(db, 'accountCodeRules', rule.id)); setConfirmDialog(null) },
    })
  }

  if (!activeProject) return <div className="page page-standard"><p className="loading">Loading…</p></div>

  const filteredCodes = typeFilter === 'all' ? codes : codes.filter(c => c.type === typeFilter)

  return (
    <div className="page page-standard">
      <ProjectBanner />
      <h2>Account Codes</h2>
      <p className="hint">
        A chart of accounts for "{activeProject.name}" — optional alongside Category for now. Assign a code to an
        Expense or Income record from Upload, Income, or Records; "Remember for this vendor" saves a rule below.
      </p>

      <div className="card">
        <h3>Import from CSV</h3>
        <p className="hint">
          For a company that already has a chart of accounts in a spreadsheet — needs Code and Name columns, Type
          optional (defaults to Expense). A code already in this list is skipped, never duplicated or overwritten.
        </p>
        <input ref={csvRef} type="file" accept=".csv,text/csv" onChange={handleCsvImport} disabled={importing} />
        {importing && <p className="hint">Importing…</p>}
        {importMessage && <p className="hint">{importMessage}</p>}
      </div>

      {codes.length === 0 ? (
        <div className="card">
          <p className="empty">No account codes yet.</p>
          <button className="btn-primary" onClick={loadStarterChart} disabled={seeding}>
            {seeding ? 'Loading…' : 'Load Starter Chart of Accounts'}
          </button>
        </div>
      ) : (
        <div className="card">
          <div className="card-header">
            <h3>Chart of Accounts</h3>
            <div className="preset-btns">
              <button className={`btn-small${typeFilter === 'all' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setTypeFilter('all')}>All</button>
              {TYPE_ORDER.map(t => (
                <button key={t} className={`btn-small${typeFilter === t ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setTypeFilter(t)}>{TYPE_LABELS[t]}</button>
              ))}
            </div>
          </div>
          {filteredCodes.map(c => (
            <div key={c.id} className="category-row">
              <span>
                <strong>{c.code}</strong> {c.name}
                <span className="hint"> · {TYPE_LABELS[c.type] || c.type}</span>
                {!c.active && <span className="badge badge-other" style={{ marginLeft: 6 }}>Inactive</span>}
              </span>
              <button className={`btn-small${c.active ? ' btn-ghost' : ' btn-primary'}`} onClick={() => toggleActive(c)}>
                {c.active ? 'Deactivate' : 'Reactivate'}
              </button>
            </div>
          ))}
          <div className="filter-row" style={{ marginTop: 12 }}>
            <input type="text" placeholder="Code, e.g. 5200" value={newCode.code} onChange={e => setNewCode({ ...newCode, code: e.target.value })} style={{ maxWidth: 120 }} />
            <input type="text" placeholder="Name" value={newCode.name} onChange={e => setNewCode({ ...newCode, name: e.target.value })} />
            <select value={newCode.type} onChange={e => setNewCode({ ...newCode, type: e.target.value })}>
              {TYPE_ORDER.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
            <button className="btn-small btn-primary" onClick={addCode} disabled={adding || !newCode.code.trim() || !newCode.name.trim()}>Add Code</button>
          </div>
        </div>
      )}

      {rules.length > 0 && (
        <div className="card">
          <h3>Account Code Rules</h3>
          <p className="hint">
            Saved from "Remember this code for…" when assigning a code on Upload, Income, or Records — always a
            suggestion, shown editable, never applied automatically.
          </p>
          {rules.map(rule => (
            <div key={rule.id} className="category-row">
              <span>
                <strong>{rule.merchantLabel || rule.merchantKey}</strong>
                <span className="hint"> ({rule.recordType}) → {rule.accountCode} · {rule.accountName}</span>
              </span>
              <button className="btn-small btn-danger" onClick={() => deleteRule(rule)}>Delete</button>
            </div>
          ))}
        </div>
      )}

      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          confirmClassName={confirmDialog.confirmClassName}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  )
}
