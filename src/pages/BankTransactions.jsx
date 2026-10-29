// Finance repositioning MVP-4: "Bank Transactions" — the single browsing
// view of every imported statement row, independent of any specific
// matching workflow (spec §3/§10). Receipt linking is available directly;
// other reconciliation actions remain in Reconciliation.
import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import ExcelJS from 'exceljs'
import { collection, query, where, onSnapshot, doc, runTransaction, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import { paymentTransactionsQuery } from '../lib/projectAccess'
import { resolveMatchedRecord } from '../lib/financeRecords'
import { reconciliationStatusLabel, CREATE_EXPENSE_BLOCKED_TYPES } from '../lib/paymentMatching'
import { CLASSIFICATION_LABELS } from '../lib/expenseClassification'
import { STATEMENT_EXPORT_COLUMNS, statementExportRow } from '../lib/statementTransactionExport'
import { filterBankTransactionRows } from '../lib/bankTransactionFilters'
import { uploadReceiptImage, deleteReceiptImage, MAX_IMAGES } from '../receiptStorage'
import FileUploadProgress from '../components/FileUploadProgress'

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
  const [loadedSources, setLoadedSources] = useState({})
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [receiptTxnId, setReceiptTxnId] = useState(null)
  const [receiptMode, setReceiptMode] = useState('new')
  const [receiptFile, setReceiptFile] = useState(null)
  const [expenseSearch, setExpenseSearch] = useState('')
  const [chosenExpenseId, setChosenExpenseId] = useState('')
  const [receiptBusy, setReceiptBusy] = useState(false)
  const [receiptProgress, setReceiptProgress] = useState(null)
  const [receiptError, setReceiptError] = useState('')

  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(() => isoDate(new Date()))
  const [accountFilter, setAccountFilter] = useState('all')
  const [accountSearch, setAccountSearch] = useState('')
  const [accountTypeFilter, setAccountTypeFilter] = useState('all')
  const [directionFilter, setDirectionFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [dateOrder, setDateOrder] = useState('desc')

  useEffect(() => {
    setAccountFilter('all')
    setAccountSearch('')
    setAccountTypeFilter('all')
    setReceiptTxnId(null)
  }, [activeProject?.id])

  useEffect(() => {
    if (!activeProject) return
    setLoading(true)
    setExportError('')
    setLoadedSources({ projectId: activeProject.id })
    const markLoaded = key => setLoadedSources(prev => ({ ...(prev.projectId === activeProject.id ? prev : { projectId: activeProject.id }), [key]: true }))
    const loadFailed = () => setExportError('Could not load all the information needed for Excel. Reload the page and try again.')
    const uid = auth.currentUser.uid
    const unsubT = onSnapshot(
      paymentTransactionsQuery(query(collection(db, 'paymentTransactions'), where('projectId', '==', activeProject.id)), activeProject, uid),
      snap => { setTransactions(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setLoading(false); markLoaded('transactions') }, loadFailed
    )
    const unsubA = onSnapshot(
      query(collection(db, 'paymentAccounts'), where('projectId', '==', activeProject.id)),
      snap => { setAccounts(snap.docs.map(d => ({ id: d.id, ...d.data() }))); markLoaded('accounts') }, loadFailed
    )
    const unsubImp = onSnapshot(
      query(collection(db, 'paymentImports'), where('projectId', '==', activeProject.id)),
      snap => { setImports(snap.docs.map(d => ({ id: d.id, ...d.data() }))); markLoaded('imports') }, loadFailed
    )
    const unsubE = onSnapshot(
      query(collection(db, 'expenses'), where('projectId', '==', activeProject.id)),
      snap => { setExpenses(snap.docs.map(d => ({ id: d.id, ...d.data() }))); markLoaded('expenses') }, loadFailed
    )
    const unsubI = onSnapshot(
      query(collection(db, 'salesInvoices'), where('projectId', '==', activeProject.id)),
      snap => { setInvoices(snap.docs.map(d => ({ id: d.id, ...d.data() }))); markLoaded('invoices') }, loadFailed
    )
    const unsubP = onSnapshot(
      query(collection(db, 'purchaseOrders'), where('projectId', '==', activeProject.id)),
      snap => { setPurchaseOrders(snap.docs.map(d => ({ id: d.id, ...d.data() }))); markLoaded('purchaseOrders') }, loadFailed
    )
    const unsubInc = onSnapshot(
      query(collection(db, 'income'), where('projectId', '==', activeProject.id)),
      snap => { setIncome(snap.docs.map(d => ({ id: d.id, ...d.data() }))); markLoaded('income') }, loadFailed
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
    return filterBankTransactionRows(rows, accounts, {
      from, to, accountId: accountFilter, accountSearch, accountType: accountTypeFilter,
      direction: directionFilter, status: statusFilter, source: sourceFilter, dateOrder,
    })
  }, [rows, from, to, accountFilter, accountSearch, accountTypeFilter, directionFilter, statusFilter, sourceFilter, dateOrder, accounts])

  const exportReady = loadedSources.projectId === activeProject?.id &&
    ['transactions', 'accounts', 'imports', 'expenses', 'invoices', 'purchaseOrders', 'income'].every(key => loadedSources[key])

  const receiptRow = rows.find(row => row.txn.id === receiptTxnId)
  const receiptTxn = receiptRow?.txn
  const linkedExpense = receiptRow?.matched?.recordType === 'expense' && receiptTxn?.status === 'matched'
    ? receiptRow.matched.record : null
  const expenseResults = receiptTxn
    ? expenses.filter(expense => {
        if (!expense.images?.length) return false
        if (expenseSearch.trim()) {
          const text = [expense.vendor, expense.date, expense.currency, Number(expense.amount || 0).toFixed(2)].join(' ').toLowerCase()
          return text.includes(expenseSearch.trim().toLowerCase())
        }
        return expense.currency === receiptTxn.settlementCurrency &&
          Math.abs(Number(expense.amount) - Number(receiptTxn.settlementAmount)) <= 0.01 &&
          !expense.matchedPaymentTransactionId
      }).sort((a, b) => {
        const distance = expense => Math.abs(Date.parse(expense.date) - Date.parse(receiptTxn?.transactionDate)) || Infinity
        return distance(a) - distance(b)
      }).slice(0, 20)
    : []

  function openReceipt(row) {
    setReceiptTxnId(row.txn.id)
    setReceiptMode('new')
    setReceiptFile(null)
    setExpenseSearch('')
    setChosenExpenseId('')
    setReceiptError('')
    setReceiptProgress(null)
  }

  function closeReceipt() {
    if (!receiptBusy) setReceiptTxnId(null)
  }

  async function saveReceipt() {
    if (!receiptTxn || receiptBusy) return
    const uid = auth.currentUser.uid
    const txnRef = doc(db, 'paymentTransactions', receiptTxn.id)
    const account = accountOf(receiptTxn.paymentAccountId)
    const expense = expenses.find(item => item.id === chosenExpenseId)
    let uploaded = null
    setReceiptBusy(true)
    setReceiptError('')
    setReceiptProgress(null)
    try {
      if (linkedExpense || receiptMode === 'new') {
        if (!receiptFile) throw new Error('Choose a receipt photo or PDF first.')
        const expenseRef = linkedExpense ? doc(db, 'expenses', linkedExpense.id) : doc(collection(db, 'expenses'))
        const imageIndex = linkedExpense?.images?.length || 0
        if (imageIndex >= MAX_IMAGES) throw new Error('This expense already has the maximum number of receipts.')
        uploaded = await uploadReceiptImage(receiptFile, uid, expenseRef.id, `${imageIndex}-${crypto.randomUUID()}`, setReceiptProgress)
        if (linkedExpense) {
          await runTransaction(db, async transaction => {
            const snapshot = await transaction.get(expenseRef)
            if (!snapshot.exists() || snapshot.data().projectId !== activeProject.id || snapshot.data().matchedPaymentTransactionId !== receiptTxn.id) {
              throw new Error('This expense changed. Reload the page and try again.')
            }
            const images = snapshot.data().images || []
            if (images.length !== imageIndex) throw new Error('Another receipt was added. Reload the page and try again.')
            transaction.update(expenseRef, { images: [...images, uploaded], receiptStatus: 'receipt_attached' })
          })
        } else {
          await runTransaction(db, async transaction => {
            const snapshot = await transaction.get(txnRef)
            if (!snapshot.exists() || snapshot.data().projectId !== activeProject.id || snapshot.data().direction !== 'debit' ||
              CREATE_EXPENSE_BLOCKED_TYPES.includes(snapshot.data().transactionType) || !['unmatched', 'suggested'].includes(snapshot.data().status) ||
              snapshot.data().matchedInvoiceIds?.length || snapshot.data().matchedPoId || snapshot.data().matchedIncomeId || snapshot.data().settlementGroupId) {
              throw new Error('This bank transaction changed. Reload the page and try again.')
            }
            transaction.set(expenseRef, {
              userId: uid, userEmail: auth.currentUser.email, projectId: activeProject.id, recordType: 'expense',
              date: receiptTxn.transactionDate || receiptTxn.postDate || '',
              vendor: titleCase(receiptTxn.merchantNormalized) || receiptTxn.merchantRaw || '',
              amount: receiptTxn.settlementAmount, currency: receiptTxn.settlementCurrency,
              category: 'Other', notes: `Statement description: "${receiptTxn.merchantRaw || ''}". Review this expense and its receipt.`,
              paymentMethod: '', images: [uploaded], receiptStatus: 'receipt_attached',
              reconciliationStatus: 'created_from_statement',
              source: account?.sourceType === 'credit_card' ? 'credit_card_statement' : 'bank_statement',
              sourceStatementImportId: receiptTxn.importId || null,
              sourceStatementRowText: receiptTxn.rawRowText || null,
              settlementAmount: receiptTxn.settlementAmount, settlementCurrency: receiptTxn.settlementCurrency,
              settlementStatus: 'confirmed', matchedPaymentTransactionId: receiptTxn.id,
              matchedPaymentAccountId: receiptTxn.paymentAccountId, createdAt: serverTimestamp(),
            })
            transaction.update(txnRef, { status: 'matched', matchedExpenseIds: [expenseRef.id], confidenceScore: null, matchReasons: [], updatedAt: serverTimestamp() })
            transaction.set(doc(collection(db, 'reconciliationActions')), {
              userId: uid, projectId: activeProject.id, paymentTransactionId: receiptTxn.id, expenseId: expenseRef.id,
              actionType: 'expense_created', beforeState: { status: snapshot.data().status }, afterState: { status: 'matched' },
              createdAt: serverTimestamp(), actor: { uid, email: auth.currentUser.email },
            })
          })
        }
      } else {
        if (!expense?.images?.length) throw new Error('Choose an existing expense with a receipt.')
        const expenseRef = doc(db, 'expenses', expense.id)
        await runTransaction(db, async transaction => {
          const [txnSnapshot, expenseSnapshot] = await Promise.all([transaction.get(txnRef), transaction.get(expenseRef)])
          if (!txnSnapshot.exists() || txnSnapshot.data().projectId !== activeProject.id || txnSnapshot.data().direction !== 'debit' ||
            CREATE_EXPENSE_BLOCKED_TYPES.includes(txnSnapshot.data().transactionType) ||
            !['unmatched', 'suggested'].includes(txnSnapshot.data().status) || txnSnapshot.data().matchedInvoiceIds?.length ||
            txnSnapshot.data().matchedPoId || txnSnapshot.data().matchedIncomeId || txnSnapshot.data().settlementGroupId) {
            throw new Error('This bank transaction changed. Reload the page and try again.')
          }
          if (!expenseSnapshot.exists() || expenseSnapshot.data().projectId !== activeProject.id || !expenseSnapshot.data().images?.length ||
            (expenseSnapshot.data().matchedPaymentTransactionId && expenseSnapshot.data().matchedPaymentTransactionId !== receiptTxn.id)) {
            throw new Error('This expense changed or is linked elsewhere. Reload the page and try again.')
          }
          transaction.update(txnRef, { status: 'matched', matchedExpenseIds: [expense.id], confidenceScore: null, matchReasons: [], updatedAt: serverTimestamp() })
          transaction.update(expenseRef, {
            matchedPaymentTransactionId: receiptTxn.id, matchedPaymentAccountId: receiptTxn.paymentAccountId,
            settlementAmount: receiptTxn.settlementAmount, settlementCurrency: receiptTxn.settlementCurrency,
            settlementStatus: 'confirmed', sourceStatementImportId: receiptTxn.importId || null,
            sourceStatementRowText: receiptTxn.rawRowText || null, receiptStatus: 'receipt_attached',
          })
          transaction.set(doc(collection(db, 'reconciliationActions')), {
            userId: uid, projectId: activeProject.id, paymentTransactionId: receiptTxn.id, expenseId: expense.id,
            actionType: 'matched', beforeState: { status: txnSnapshot.data().status }, afterState: { status: 'matched' },
            createdAt: serverTimestamp(), actor: { uid, email: auth.currentUser.email },
          })
        })
      }
      setReceiptTxnId(null)
    } catch (error) {
      if (uploaded) await deleteReceiptImage(uploaded.path).catch(() => {})
      setReceiptError(error.code ? 'Could not save the receipt. Please try again or reload the page.' : (error.message || 'Could not save the receipt. Please try again.'))
    } finally {
      setReceiptBusy(false)
      setReceiptProgress(null)
    }
  }

  async function downloadExcel() {
    if (!exportReady || !filteredRows.length || exporting) return
    setExporting(true)
    setExportError('')
    try {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Statement Transactions')
      sheet.columns = STATEMENT_EXPORT_COLUMNS
      sheet.getRow(1).font = { bold: true }
      sheet.views = [{ state: 'frozen', ySplit: 1 }]
      sheet.autoFilter = { from: 'A1', to: `Q${filteredRows.length + 1}` }
      for (const row of filteredRows) {
        sheet.addRow(statementExportRow(row, accountOf(row.txn.paymentAccountId), importOf(row.txn.importId), CLASSIFICATION_LABELS))
      }
      const buffer = await workbook.xlsx.writeBuffer()
      const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `statement-transactions_${(activeProject.name || 'project').replace(/[^a-zA-Z0-9-]+/g, '-')}_${from || 'all'}_${to || 'time'}.xlsx`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setExportError(`Could not create Excel file: ${err.message}`)
    } finally {
      setExporting(false)
    }
  }

  if (!activeProject) return <div className="page page-wide"><p className="loading">Loading…</p></div>

  return (
    <div className="page page-wide">
      <ProjectBanner />
      <h2>Imported Transactions</h2>
      <p className="hint" style={{ marginTop: -8, marginBottom: 16 }}>
        Review imported bank and card transactions. Add a receipt here, or open Reconciliation for other actions.
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
          {accounts.map(a => <option key={a.id} value={a.id}>{a.label}{a.accountTail && !a.label?.includes(a.accountTail) ? ` ···${a.accountTail}` : ''}</option>)}
        </select>
        <input type="search" aria-label="Search account name or number" placeholder="Account name or number" value={accountSearch} onChange={e => setAccountSearch(e.target.value)} />
        <select aria-label="Account type" value={accountTypeFilter} onChange={e => setAccountTypeFilter(e.target.value)}>
          <option value="all">All account types</option>
          <option value="current">Current</option>
          <option value="savings">Savings</option>
          <option value="credit_card">Credit card</option>
          <option value="unspecified">Bank type not set</option>
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
        <select aria-label="Date order" value={dateOrder} onChange={e => setDateOrder(e.target.value)}>
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
      </div>

      <div className="filter-row" style={{ marginBottom: 12 }}>
        <button className="btn-small btn-ghost" onClick={downloadExcel} disabled={!exportReady || !filteredRows.length || exporting}>
          {exporting ? 'Preparing Excel…' : `Download Excel (${filteredRows.length} rows)`}
        </button>
        <span className="hint">Downloads only the rows matching the filters above, in the order shown. Debits are negative; credits are positive. Personal-account transactions may be included; keep the file private.</span>
      </div>
      {exportError && <p className="error-msg">{exportError}</p>}

      {loading ? (
        <p className="loading">Loading…</p>
      ) : filteredRows.length === 0 ? (
        <p className="empty">
          {transactions.length === 0 ? 'No statement transactions imported yet.' : 'Nothing matches the current filters.'}
        </p>
      ) : (
        <>
        <div className="table-wrap desktop-only">
          <table className="expense-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Direction</th>
                <th>Amount</th>
                <th>Description</th>
                <th>Classification</th>
                <th>Status</th>
                <th>Matched Record</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ txn, matched, status }) => {
                const imp = importOf(txn.importId)
                const record = matched?.record
                const supportingDoc = matched?.recordType === 'expense' ? record.images?.[0]?.url : null
                const canAddReceipt = txn.direction === 'debit' && !CREATE_EXPENSE_BLOCKED_TYPES.includes(txn.transactionType) &&
                  (txn.status === 'unmatched' || txn.status === 'suggested' || (txn.status === 'matched' && matched?.recordType === 'expense'))
                return (
                  <tr key={txn.id}>
                    <td>
                      {txn.transactionDate || txn.rawDateText || '—'}
                      {txn.postDate && txn.postDate !== txn.transactionDate && <div className="hint">Value: {txn.postDate}</div>}
                    </td>
                    <td>{txn.direction || '—'}</td>
                    <td>
                      {txn.settlementCurrency} {txn.settlementAmount != null ? Number(txn.settlementAmount).toFixed(2) : '—'}
                      {txn.balanceAfter != null && <div className="hint">Bal: {Number(txn.balanceAfter).toFixed(2)}</div>}
                    </td>
                    <td>
                      <div className="notes-cell" title={txn.merchantRaw}>{txn.merchantRaw || '—'}</div>
                      <div className="hint">{titleCase(txn.merchantNormalized) || '—'}</div>
                    </td>
                    <td>
                      {txn.transactionType || '—'}
                      {txn.classification && <div className="hint">{CLASSIFICATION_LABELS[txn.classification] || txn.classification}</div>}
                      {record?.accountCode && <div className="hint">{record.accountCode} · {record.accountName || ''}</div>}
                    </td>
                    <td><span className="badge">{status}</span></td>
                    <td>
                      {recordSummary(matched) || '—'}
                      {supportingDoc && <div className="hint"><a href={supportingDoc} target="_blank" rel="noreferrer">Supporting Document</a></div>}
                      {imp?.sourceFileUrl && <div className="hint"><a href={imp.sourceFileUrl} target="_blank" rel="noreferrer">Source File</a></div>}
                    </td>
                    <td><div className="statement-actions">
                      {canAddReceipt && <button type="button" className="btn-small" onClick={() => openReceipt({ txn, matched, status })}>{supportingDoc ? 'Receipts' : 'Add receipt'}</button>}
                      <Link to={`/reconciliation?txn=${txn.id}`} className="btn-small btn-ghost">Reconciliation →</Link>
                    </div></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="mobile-only">
          {filteredRows.map(({ txn, matched, status }) => {
            const imp = importOf(txn.importId)
            const record = matched?.record
            const supportingDoc = matched?.recordType === 'expense' ? record.images?.[0]?.url : null
            const canAddReceipt = txn.direction === 'debit' && !CREATE_EXPENSE_BLOCKED_TYPES.includes(txn.transactionType) &&
              (txn.status === 'unmatched' || txn.status === 'suggested' || (txn.status === 'matched' && matched?.recordType === 'expense'))
            return (
              <div key={txn.id} className="expense-mob-card">
                <div className="mob-card-header">
                  <span className="mob-card-vendor">{txn.merchantRaw || '—'}</span>
                  <span className="mob-card-amount">{txn.settlementCurrency} {txn.settlementAmount != null ? Number(txn.settlementAmount).toFixed(2) : '—'}</span>
                </div>
                <div className="mob-card-sub">
                  <span className="mob-card-date">{txn.transactionDate || txn.rawDateText || '—'} · {txn.direction || '—'}</span>
                  <span className="badge">{status}</span>
                </div>
                <div className="hint">{titleCase(txn.merchantNormalized) || '—'}</div>
                {txn.classification && <div className="hint">{CLASSIFICATION_LABELS[txn.classification] || txn.classification}</div>}
                {record?.accountCode && <div className="hint">{record.accountCode} · {record.accountName || ''}</div>}
                <div className="mob-card-notes">{recordSummary(matched) || 'Not matched to a record yet'}</div>
                {supportingDoc && <div className="hint"><a href={supportingDoc} target="_blank" rel="noreferrer">Supporting Document</a></div>}
                {imp?.sourceFileUrl && <div className="hint"><a href={imp.sourceFileUrl} target="_blank" rel="noreferrer">Source File</a></div>}
                <div className="mob-card-actions">
                  {canAddReceipt && <button type="button" className="btn-small" onClick={() => openReceipt({ txn, matched, status })}>{supportingDoc ? 'Receipts' : 'Add receipt'}</button>}
                  <Link to={`/reconciliation?txn=${txn.id}`} className="btn-small btn-ghost">Reconciliation →</Link>
                </div>
              </div>
            )
          })}
        </div>
        </>
      )}
      {receiptTxn && <div className="lightbox-overlay" onClick={closeReceipt}>
        <div className="lightbox-box receipt-dialog" role="dialog" aria-modal="true" aria-label="Receipt for bank transaction" onClick={event => event.stopPropagation()}>
          <button type="button" className="lightbox-close" aria-label="Close" disabled={receiptBusy} onClick={closeReceipt}>×</button>
          <h3 className="lightbox-title">Receipt for transaction</h3>
          <p>{receiptTxn.transactionDate || 'No date'} · {receiptTxn.merchantRaw || 'No description'} · {receiptTxn.settlementCurrency} {Number(receiptTxn.settlementAmount || 0).toFixed(2)}</p>
          {linkedExpense ? <>
            <p className="hint">Linked to {linkedExpense.vendor || 'Expense'}. Add another receipt to this expense.</p>
            {(linkedExpense.images || []).map(image => <p key={image.path}><a href={image.url} target="_blank" rel="noreferrer">{image.name || 'View receipt'}</a></p>)}
          </> : <>
            <div className="action-row">
              <button type="button" className={`btn-small${receiptMode === 'new' ? '' : ' btn-ghost'}`} disabled={receiptBusy} onClick={() => { setReceiptMode('new'); setReceiptError('') }}>New receipt</button>
              <button type="button" className={`btn-small${receiptMode === 'existing' ? '' : ' btn-ghost'}`} disabled={receiptBusy} onClick={() => { setReceiptMode('existing'); setReceiptError('') }}>Already uploaded</button>
            </div>
            {receiptMode === 'new' ? <p className="hint">Creates an expense using this transaction's details and attaches your receipt. Review its category and details in Expenses afterward.</p>
              : <p className="hint">Find an expense with a receipt already uploaded. Linking it will mark this bank transaction as matched.</p>}
          </>}
          {(linkedExpense || receiptMode === 'new') ? <>
            <input type="file" accept="image/*,application/pdf" aria-label="Choose receipt photo or PDF" disabled={receiptBusy || (linkedExpense?.images?.length || 0) >= MAX_IMAGES} onChange={event => setReceiptFile(event.target.files?.[0] || null)} />
            {linkedExpense?.images?.length >= MAX_IMAGES && <p className="hint">This expense has the maximum of {MAX_IMAGES} receipts.</p>}
          </> : <>
            <input type="search" aria-label="Find uploaded expense" placeholder="Search vendor, date, or amount" value={expenseSearch} disabled={receiptBusy} onChange={event => { setExpenseSearch(event.target.value); setChosenExpenseId('') }} />
            {!expenseSearch.trim() && <p className="hint">{expenseResults.length ? 'Expenses with receipts for the same amount:' : 'No receipts with the same amount. Search by vendor, date, or amount.'}</p>}
            {(expenseResults.length > 0 || expenseSearch.trim()) && <div className="expense-search-results">
              {expenseResults.length === 0 && <p className="hint">No expenses with receipts match that search.</p>}
              {expenseResults.map(expense => <button type="button" key={expense.id} className={`expense-search-result${chosenExpenseId === expense.id ? ' is-selected' : ''}`} disabled={receiptBusy || (expense.matchedPaymentTransactionId && expense.matchedPaymentTransactionId !== receiptTxn.id)} onClick={() => setChosenExpenseId(expense.id)}>
                {expense.date} · {expense.vendor} · {expense.currency} {Number(expense.amount || 0).toFixed(2)} · {expense.images.length} receipt(s)
                {expense.matchedPaymentTransactionId && expense.matchedPaymentTransactionId !== receiptTxn.id ? ' · linked elsewhere' : ''}
              </button>)}
            </div>}
            {chosenExpenseId && (() => {
              const expense = expenses.find(item => item.id === chosenExpenseId)
              return expense && (expense.currency !== receiptTxn.settlementCurrency || Math.abs(Number(expense.amount) - Number(receiptTxn.settlementAmount)) > 0.01)
                ? <p className="badge badge-warning">The expense amount or currency differs from the bank transaction. Check before linking.</p> : null
            })()}
          </>}
          {receiptProgress != null && <FileUploadProgress label="Receipt file" percent={receiptProgress} />}
          {receiptError && <p className="error-msg" role="alert">{receiptError}</p>}
          <div className="action-row">
            <button type="button" className="btn-primary" disabled={receiptBusy || (linkedExpense || receiptMode === 'new' ? !receiptFile || (linkedExpense?.images?.length || 0) >= MAX_IMAGES : !chosenExpenseId)} onClick={saveReceipt}>
              {receiptBusy ? 'Saving…' : linkedExpense ? 'Add receipt' : receiptMode === 'new' ? 'Create expense with receipt' : 'Link expense'}
            </button>
            <button type="button" className="btn-ghost" disabled={receiptBusy} onClick={closeReceipt}>Cancel</button>
          </div>
        </div>
      </div>}
    </div>
  )
}
