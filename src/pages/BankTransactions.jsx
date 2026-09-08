// Finance repositioning MVP-4: "Bank Transactions" — the single browsing
// view of every imported statement row, independent of any specific
// matching workflow (spec §3/§10). Read-only except a link out to
// Reconciliation, which already owns every match/confirm/ignore action —
// this page does not duplicate that logic.
import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { collection, query, where, onSnapshot } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import { paymentTransactionsQuery } from '../lib/projectAccess'
import { resolveMatchedRecord } from '../lib/financeRecords'
import { reconciliationStatusLabel } from '../lib/paymentMatching'
import { CLASSIFICATION_LABELS } from '../lib/expenseClassification'

function isoDate(d) { return d.toISOString().slice(0, 10) }
function firstOfMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

const STATUS_OPTIONS = ['Suggested', 'Confirmed', 'Needs Review', 'Missing Document', 'Unmatched', 'Excluded']

function titleCase(s) {
  return (s || '').replace(/\b\w/g, c => c.toUpperCase())
}

function recordSummary(matched) {
  if (!matched) return null
  const { recordType, record } = matched
  const amount = record.amount != null ? `${record.currency || ''} ${Number(record.amount).toFixed(2)}`.trim() : ''
  if (recordType === 'expense') return `Expense · ${record.vendor || '—'} · ${amount}`
  if (recordType === 'income') return `Income · ${record.counterpartyName || '—'} · ${amount}`
  if (recordType === 'invoice') return `Invoice · ${record.counterpartyName || '—'} · ${amount}`
  if (recordType === 'po') return `Purchase Order · ${record.counterpartyName || '—'} · ${amount}`
  return null
}

export default function BankTransactions() {
  const { activeProject } = useProject()
  const [transactions, setTransactions] = useState([])
  const [accounts, setAccounts] = useState([])
  const [imports, setImports] = useState([])
  const [expenses, setExpenses] = useState([])
  const [invoices, setInvoices] = useState([])
  const [purchaseOrders, setPurchaseOrders] = useState([])
  const [income, setIncome] = useState([])
  const [loading, setLoading] = useState(true)

  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(() => isoDate(new Date()))
  const [accountFilter, setAccountFilter] = useState('all')
  const [directionFilter, setDirectionFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')

  useEffect(() => {
    if (!activeProject) return
    setLoading(true)
    const uid = auth.currentUser.uid
    const unsubT = onSnapshot(
      paymentTransactionsQuery(query(collection(db, 'paymentTransactions'), where('projectId', '==', activeProject.id)), activeProject, uid),
      snap => { setTransactions(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setLoading(false) }
    )
    const unsubA = onSnapshot(
      query(collection(db, 'paymentAccounts'), where('projectId', '==', activeProject.id)),
      snap => setAccounts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubImp = onSnapshot(
      query(collection(db, 'paymentImports'), where('projectId', '==', activeProject.id)),
      snap => setImports(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubE = onSnapshot(
      query(collection(db, 'expenses'), where('projectId', '==', activeProject.id)),
      snap => setExpenses(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubI = onSnapshot(
      query(collection(db, 'salesInvoices'), where('projectId', '==', activeProject.id)),
      snap => setInvoices(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubP = onSnapshot(
      query(collection(db, 'purchaseOrders'), where('projectId', '==', activeProject.id)),
      snap => setPurchaseOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubInc = onSnapshot(
      query(collection(db, 'income'), where('projectId', '==', activeProject.id)),
      snap => setIncome(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    return () => { unsubT(); unsubA(); unsubImp(); unsubE(); unsubI(); unsubP(); unsubInc() }
  }, [activeProject?.id])

  const accountOf = id => accounts.find(a => a.id === id)
  const importOf = id => imports.find(i => i.id === id)

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

  const rows = useMemo(() => {
    return transactions.map(txn => {
      const matched = resolveMatchedRecord(txn, { expenses, invoices, purchaseOrders, income })
      return { txn, matched, status: reconciliationStatusLabel(txn, matched) }
    })
  }, [transactions, expenses, invoices, purchaseOrders, income])

  const filteredRows = useMemo(() => {
    return rows.filter(({ txn, status }) => {
      if (from && (txn.transactionDate || '') < from) return false
      if (to && (txn.transactionDate || '') > to) return false
      if (accountFilter !== 'all' && txn.paymentAccountId !== accountFilter) return false
      if (directionFilter !== 'all' && txn.direction !== directionFilter) return false
      if (statusFilter !== 'all' && status !== statusFilter) return false
      if (sourceFilter !== 'all' && accountOf(txn.paymentAccountId)?.sourceType !== sourceFilter) return false
      return true
    }).sort((a, b) => (b.txn.transactionDate || '').localeCompare(a.txn.transactionDate || ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, from, to, accountFilter, directionFilter, statusFilter, sourceFilter, accounts])

  if (!activeProject) return <div className="page page-wide"><p className="loading">Loading…</p></div>

  return (
    <div className="page page-wide">
      <ProjectBanner />
      <h2>Bank Transactions</h2>
      <p className="hint" style={{ marginTop: -8, marginBottom: 16 }}>
        Every imported statement row, browsable independent of any specific matching workflow. Select "Open in Reconciliation" to act on one.
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

      <div className="filter-row" style={{ marginBottom: 12 }}>
        <select value={accountFilter} onChange={e => setAccountFilter(e.target.value)}>
          <option value="all">All accounts</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <select value={directionFilter} onChange={e => setDirectionFilter(e.target.value)}>
          <option value="all">All directions</option>
          <option value="debit">Debit</option>
          <option value="credit">Credit</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
          <option value="all">All sources</option>
          <option value="bank">Bank</option>
          <option value="credit_card">Credit Card</option>
        </select>
      </div>

      {loading ? (
        <p className="loading">Loading…</p>
      ) : filteredRows.length === 0 ? (
        <p className="empty">
          {transactions.length === 0 ? 'No statement transactions imported yet.' : 'Nothing matches the current filters.'}
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="expense-table">
            <thead>
              <tr>
                <th>Transaction Date</th>
                <th>Value Date</th>
                <th>Direction</th>
                <th>Amount</th>
                <th>Balance</th>
                <th>Description</th>
                <th>Counterparty</th>
                <th>Classification</th>
                <th>Account Code</th>
                <th>Status</th>
                <th>Matched Record</th>
                <th>Supporting Document</th>
                <th>Source File</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ txn, matched, status }) => {
                const account = accountOf(txn.paymentAccountId)
                const imp = importOf(txn.importId)
                const record = matched?.record
                const accountCodeText = record?.accountCode ? `${record.accountCode} · ${record.accountName || ''}` : '—'
                const supportingDoc = matched?.recordType === 'expense' ? record.images?.[0]?.url : null
                return (
                  <tr key={txn.id}>
                    <td>{txn.transactionDate || txn.rawDateText || '—'}</td>
                    <td>{txn.postDate || '—'}</td>
                    <td>{txn.direction || '—'}</td>
                    <td>{txn.settlementCurrency} {txn.settlementAmount != null ? Number(txn.settlementAmount).toFixed(2) : '—'}</td>
                    <td>{txn.balanceAfter != null ? Number(txn.balanceAfter).toFixed(2) : '—'}</td>
                    <td>{txn.merchantRaw || '—'}</td>
                    <td>{titleCase(txn.merchantNormalized) || '—'}</td>
                    <td>
                      {txn.transactionType || '—'}
                      {txn.classification && <div className="hint">{CLASSIFICATION_LABELS[txn.classification] || txn.classification}</div>}
                    </td>
                    <td>{accountCodeText}</td>
                    <td><span className="badge">{status}</span></td>
                    <td>{recordSummary(matched) || '—'}</td>
                    <td>{supportingDoc ? <a href={supportingDoc} target="_blank" rel="noreferrer">View</a> : '—'}</td>
                    <td>{imp?.sourceFileUrl ? <a href={imp.sourceFileUrl} target="_blank" rel="noreferrer">Original</a> : '—'}</td>
                    <td><Link to={`/reconciliation?txn=${txn.id}`} className="btn-small btn-ghost">Open in Reconciliation →</Link></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
