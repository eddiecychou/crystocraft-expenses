// Finance repositioning MVP-6: Month-End Report — a downloadable export
// (ZIP: one multi-sheet Excel workbook + Reconciled/Unreconciled/Missing
// Document/Uncoded CSVs + a manifest) across all four FinanceRecord
// collections, filterable by date range, record type, Account Code, and
// reconciliation status (spec §11/§12). Reuses the exact JSZip+ExcelJS+
// CSV pattern already proven in CompanyReview.jsx's Company Package
// export — that one is scoped to Expense/bank-transaction classification;
// this one covers the full picture the same way Dashboard's Overview
// extension does. Rebuilt in place from the previously-orphaned
// Export.jsx (no route/nav link existed; its old single-collection Excel
// download was already superseded by Expenses.jsx's own export).
//
// Spec vocabulary note: "Needs Review" and "sync-failed" are NOT modeled
// as buckets here — neither maps cleanly onto a field shared by all four
// collections (needs_accountant_review only exists on Expense-side bank
// classification; sync-failed is a project-level Operation Center status,
// not a per-record list) — same "best-effort display mapping now"
// precedent as reconciliationStatusLabel() (MVP-4).
import { useState, useEffect } from 'react'
import { collection, query, where, onSnapshot } from 'firebase/firestore'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import { useAccountCodes } from '../hooks/useAccountCodes'
import { recordReconciliationStatus } from '../lib/financeRecords'

const STATUS_OPTIONS = ['Reconciled', 'Unreconciled', 'Missing Document']

const RECORD_KINDS = [
  { key: 'expense', label: 'Expenses', collection: 'expenses', sheet: 'Expenses' },
  { key: 'income', label: 'Income', collection: 'income', sheet: 'Income' },
  { key: 'invoice', label: 'Sales Invoices', collection: 'salesInvoices', sheet: 'Sales Invoices' },
  { key: 'po', label: 'Purchase Orders', collection: 'purchaseOrders', sheet: 'Purchase Orders' },
]

function isoDate(d) { return d.toISOString().slice(0, 10) }
function firstOfMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function toCsv(headers, rows) {
  const esc = v => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n')
}

function counterpartyOf(record) { return record.vendor ?? record.counterpartyName ?? '' }
function sourceOf(record) { return record.source ?? record.sourceType ?? '' }

export default function Export() {
  const { activeProject } = useProject()
  const { accountCodes } = useAccountCodes(activeProject?.id)
  const [records, setRecords] = useState({ expense: [], income: [], invoice: [], po: [] })
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(() => isoDate(new Date()))
  const [enabledKinds, setEnabledKinds] = useState(() => Object.fromEntries(RECORD_KINDS.map(k => [k.key, true])))
  const [accountCodeFilter, setAccountCodeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [uncodedOnly, setUncodedOnly] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!activeProject) return
    const unsubs = RECORD_KINDS.map(({ key, collection: coll }) =>
      onSnapshot(
        query(collection(db, coll), where('projectId', '==', activeProject.id)),
        snap => setRecords(prev => ({ ...prev, [key]: snap.docs.map(d => ({ id: d.id, ...d.data() })) }))
      )
    )
    return () => unsubs.forEach(u => u())
  }, [activeProject?.id])

  function setPreset(preset) {
    const now = new Date()
    if (preset === 'this-month') {
      setFrom(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
      setTo(isoDate(now))
    } else if (preset === 'last-month') {
      const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
      const m = now.getMonth() === 0 ? 12 : now.getMonth()
      setFrom(`${y}-${String(m).padStart(2, '0')}-01`)
      setTo(isoDate(new Date(now.getFullYear(), now.getMonth(), 0)))
    } else if (preset === 'this-year') {
      setFrom(`${now.getFullYear()}-01-01`)
      setTo(isoDate(now))
    } else {
      setFrom('')
      setTo('')
    }
  }

  // Applies date range + record type + Account Code + status + uncoded
  // filters, returning { expense: [...], income: [...], invoice: [...], po: [...] }
  // — each entry already carries its own resolved reconciliation status,
  // computed once here rather than recomputed at each use site.
  function filteredByKind() {
    const out = {}
    for (const { key } of RECORD_KINDS) {
      if (!enabledKinds[key]) { out[key] = []; continue }
      out[key] = (records[key] || [])
        .filter(r => (!from || (r.date || '') >= from) && (!to || (r.date || '') <= to))
        .filter(r => accountCodeFilter === 'all' || r.accountCodeId === accountCodeFilter)
        .filter(r => !uncodedOnly || !r.accountCodeId)
        .map(r => ({ ...r, _status: recordReconciliationStatus(r) }))
        .filter(r => statusFilter === 'all' || r._status === statusFilter)
    }
    return out
  }

  const preview = filteredByKind()
  const totalCount = RECORD_KINDS.reduce((sum, { key }) => sum + preview[key].length, 0)

  async function generateReport() {
    const byKind = filteredByKind()
    if (totalCount === 0) { alert('No records match the current filters.'); return }
    setGenerating(true)
    setMessage(''); setError('')
    try {
      const zip = new JSZip()

      // month-end-report.xlsx — one worksheet per enabled record type.
      const wb = new ExcelJS.Workbook()
      for (const kind of RECORD_KINDS) {
        const rows = byKind[kind.key]
        if (rows.length === 0) continue
        const ws = wb.addWorksheet(kind.sheet)
        ws.columns = [
          { header: 'Date', key: 'date', width: 12 },
          { header: 'Counterparty', key: 'counterparty', width: 26 },
          { header: 'Amount', key: 'amount', width: 12 },
          { header: 'Currency', key: 'currency', width: 10 },
          { header: 'Category', key: 'category', width: 16 },
          { header: 'Account Code', key: 'accountCode', width: 12 },
          { header: 'Account Name', key: 'accountName', width: 18 },
          { header: 'Reconciliation Status', key: 'status', width: 18 },
          { header: 'Source', key: 'source', width: 16 },
          { header: 'Notes', key: 'notes', width: 30 },
        ]
        const hdr = ws.getRow(1)
        hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A5C38' } }
        for (const r of rows) {
          ws.addRow({
            date: r.date || '',
            counterparty: counterpartyOf(r),
            amount: r.amount ?? 0,
            currency: r.currency || '',
            category: r.category || '',
            accountCode: r.accountCode || '',
            accountName: r.accountName || '',
            status: r._status,
            source: sourceOf(r),
            notes: r.notes || '',
          })
        }
      }
      const buf = await wb.xlsx.writeBuffer()
      zip.file('month-end-report.xlsx', buf)

      // Reconciled/Unreconciled/Missing Document/Uncoded CSVs — merged
      // across all enabled record types, with a Record Type column so
      // they're distinguishable once combined. Built from the SAME
      // filtered set the workbook uses — if the Reconciliation Status
      // filter above narrowed to one status, the other buckets' CSVs
      // are simply empty (still generated, so the ZIP's shape stays
      // predictable), which is exactly what a status-narrowed export
      // asked for.
      const allRows = RECORD_KINDS.flatMap(kind => byKind[kind.key].map(r => ({ kind, r })))
      const csvHeaders = ['RecordType', 'Date', 'Counterparty', 'Amount', 'Currency', 'AccountCode', 'AccountName', 'Notes']
      function csvRows(status) {
        return allRows.filter(({ r }) => r._status === status).map(({ kind, r }) => ({
          RecordType: kind.label, Date: r.date || '', Counterparty: counterpartyOf(r),
          Amount: r.amount ?? 0, Currency: r.currency || '',
          AccountCode: r.accountCode || '', AccountName: r.accountName || '', Notes: r.notes || '',
        }))
      }
      const reconciledRows = csvRows('Reconciled')
      const unreconciledRows = csvRows('Unreconciled')
      const missingDocRows = csvRows('Missing Document')
      const uncodedRows = allRows.filter(({ r }) => !r.accountCodeId).map(({ kind, r }) => ({
        RecordType: kind.label, Date: r.date || '', Counterparty: counterpartyOf(r),
        Amount: r.amount ?? 0, Currency: r.currency || '', AccountCode: '', AccountName: '', Notes: r.notes || '',
      }))
      zip.file('reconciled.csv', toCsv(csvHeaders, reconciledRows))
      zip.file('unreconciled.csv', toCsv(csvHeaders, unreconciledRows))
      zip.file('missing-documents.csv', toCsv(csvHeaders, missingDocRows))
      zip.file('uncoded.csv', toCsv(csvHeaders, uncodedRows))

      // manifest.json
      const manifest = {
        company: activeProject.name,
        companyId: activeProject.id,
        from: from || null,
        to: to || null,
        recordTypesIncluded: RECORD_KINDS.filter(k => enabledKinds[k.key]).map(k => k.label),
        accountCodeFilter: accountCodeFilter === 'all' ? 'All' : (accountCodes.find(c => c.id === accountCodeFilter)?.code || accountCodeFilter),
        statusFilter: statusFilter === 'all' ? 'All' : statusFilter,
        uncodedOnly,
        generatedAt: new Date().toISOString(),
        generatedBy: auth.currentUser?.email || '',
        totalRecords: totalCount,
        counts: {
          reconciled: reconciledRows.length,
          unreconciled: unreconciledRows.length,
          missingDocuments: missingDocRows.length,
          uncoded: uncodedRows.length,
        },
      }
      zip.file('manifest.json', JSON.stringify(manifest, null, 2))

      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `month-end-report_${activeProject.name.replace(/[^a-zA-Z0-9]+/g, '-')}_${from || 'all'}_${to || 'time'}.zip`
      a.click()
      URL.revokeObjectURL(url)
      setMessage(`Generated a report for ${totalCount} record(s).`)
    } catch (err) {
      setError(err.message || 'Could not generate the report')
    }
    setGenerating(false)
  }

  if (!activeProject) return <div className="page page-standard"><p className="loading">Loading…</p></div>

  return (
    <div className="page page-standard">
      <ProjectBanner />
      <h2>Month-End Report</h2>
      <p className="hint" style={{ marginTop: -8, marginBottom: 16 }}>
        A downloadable report across Expenses, Income, Sales Invoices, and Purchase Orders — reconciled, unreconciled,
        missing-document, and uncoded lists, plus a combined workbook.
      </p>

      <div className="filter-row">
        <div className="date-range">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
          <span className="date-sep">–</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="preset-btns">
          <button onClick={() => setPreset('this-month')} className="btn-small btn-ghost">This Month</button>
          <button onClick={() => setPreset('last-month')} className="btn-small btn-ghost">Last Month</button>
          <button onClick={() => setPreset('this-year')} className="btn-small btn-ghost">This Year</button>
          <button onClick={() => setPreset('all')} className="btn-small btn-ghost">All</button>
        </div>
      </div>

      <div className="card">
        <h3>Record Types</h3>
        <div className="chip-list">
          {RECORD_KINDS.map(k => (
            <label key={k.key} className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 400, marginRight: 16 }}>
              <input type="checkbox" checked={enabledKinds[k.key]} onChange={e => setEnabledKinds({ ...enabledKinds, [k.key]: e.target.checked })} />
              {k.label} ({preview[k.key].length})
            </label>
          ))}
        </div>
      </div>

      <div className="filter-row" style={{ marginTop: 12 }}>
        <select value={accountCodeFilter} onChange={e => setAccountCodeFilter(e.target.value)} disabled={uncodedOnly}>
          <option value="all">All Account Codes</option>
          {accountCodes.map(c => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 400 }}>
          <input type="checkbox" checked={uncodedOnly} onChange={e => setUncodedOnly(e.target.checked)} />
          Uncoded only
        </label>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3 style={{ marginBottom: 0 }}>{totalCount} record(s) match the current filters</h3>
        </div>
        <button onClick={generateReport} disabled={generating || totalCount === 0} className="btn-primary" style={{ marginTop: 8 }}>
          {generating ? 'Generating…' : 'Download Month-End Report (.zip)'}
        </button>
        {message && <p className="success-msg">{message}</p>}
        {error && <div className="error-msg">{error}</div>}
      </div>
    </div>
  )
}
