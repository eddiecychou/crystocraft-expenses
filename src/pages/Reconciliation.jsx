import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { collection, query, where, onSnapshot, doc, updateDoc, addDoc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import { scoreExpenseMatch, scoreSettlementMatch, classifyReviewCategory, CREATE_EXPENSE_BLOCKED_TYPES } from '../lib/paymentMatching'
import { DUPLICATE_STATUS_LABELS } from '../lib/duplicateDetection'

const TOP_TABS = ['Needs Action', 'All', 'Matched', 'Exceptions']

const REVIEW_CATEGORY_LABELS = {
  possible_expense: 'Possible Expense',
  possible_settlement: 'Possible Credit Card Settlement',
  possible_refund: 'Possible Refund',
  possible_transfer: 'Possible Transfer',
  possible_duplicate: 'Possible Duplicate',
  unclear: 'Unclear',
}

const EXCEPTION_FILTERS = [
  { value: 'all', label: 'All exceptions' },
  { value: 'possible_settlement', label: 'Credit-card settlement' },
  { value: 'possible_refund', label: 'Possible refund' },
  { value: 'possible_transfer', label: 'Possible transfer' },
  { value: 'possible_duplicate', label: 'Possible duplicate' },
  { value: 'unclear', label: 'Unclear' },
]

export default function Reconciliation() {
  const { activeProject } = useProject()
  const [transactions, setTransactions] = useState([])
  const [expenses, setExpenses] = useState([])
  const [accounts, setAccounts] = useState([])
  const [topTab, setTopTab] = useState('Needs Action')
  const [exceptionFilter, setExceptionFilter] = useState('all')
  const [sourceTypeFilter, setSourceTypeFilter] = useState('all')
  const [searchText, setSearchText] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [matching, setMatching] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [chosenExpenseId, setChosenExpenseId] = useState('')
  const [pickingSettlement, setPickingSettlement] = useState(false)
  const [chosenCounterpart, setChosenCounterpart] = useState('')

  useEffect(() => {
    if (!activeProject) return
    const uid = auth.currentUser.uid
    const unsubT = onSnapshot(
      query(collection(db, 'paymentTransactions'), where('userId', '==', uid), where('projectId', '==', activeProject.id)),
      snap => setTransactions(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubE = onSnapshot(
      query(collection(db, 'expenses'), where('userId', '==', uid), where('projectId', '==', activeProject.id)),
      snap => setExpenses(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubA = onSnapshot(
      query(collection(db, 'paymentAccounts'), where('userId', '==', uid), where('projectId', '==', activeProject.id)),
      snap => setAccounts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    return () => { unsubT(); unsubE(); unsubA() }
  }, [activeProject?.id])

  // Reset the detail selection whenever the visible list changes shape, so
  // a stale selection from a different tab/filter can't linger unseen.
  useEffect(() => { setSelectedId(null); setChosenExpenseId(''); setPickingSettlement(false) }, [topTab, exceptionFilter, sourceTypeFilter, searchText])

  const accountOf = id => accounts.find(a => a.id === id)
  const accountLabel = id => accountOf(id)?.label || '—'
  const accountTail = id => accountOf(id)?.accountTail ? `****${accountOf(id).accountTail}` : ''
  const accountSourceLabel = id => {
    const type = accountOf(id)?.sourceType
    return type === 'credit_card' ? 'Credit Card' : type === 'bank' ? 'Bank' : '—'
  }

  async function logAction(txn, expenseId, actionType, beforeState, afterState) {
    await addDoc(collection(db, 'reconciliationActions'), {
      userId: auth.currentUser.uid,
      projectId: activeProject.id,
      paymentTransactionId: txn.id,
      expenseId: expenseId || null,
      actionType,
      beforeState,
      afterState,
      createdAt: serverTimestamp(),
      actor: { uid: auth.currentUser.uid, email: auth.currentUser.email },
    })
  }

  async function runMatching() {
    setMatching(true)
    const candidates = transactions.filter(t => t.status === 'unmatched')
    for (const txn of candidates) {
      let best = null
      for (const exp of expenses) {
        const result = scoreExpenseMatch(txn, exp)
        if (result && (!best || result.score > best.score)) best = { ...result, expenseId: exp.id }
      }
      if (best && best.score >= 50) {
        await updateDoc(doc(db, 'paymentTransactions', txn.id), {
          status: 'suggested',
          matchedExpenseIds: [best.expenseId],
          confidenceScore: best.score,
          matchReasons: best.reasons,
          updatedAt: serverTimestamp(),
        })
      }
    }
    setMatching(false)
  }

  // Settlement candidates (card `payment` row -> bank `debit` row) are cheap
  // to compute live from what's already loaded — no need to persist a
  // suggestion until the user actually confirms the link.
  const settlementCandidates = useMemo(() => {
    const cardPayments = transactions.filter(t => t.transactionType === 'payment' && !t.settlementGroupId)
    const bankDebits = transactions.filter(t => t.direction === 'debit' && t.transactionType !== 'payment' && !t.settlementGroupId)
    const out = []
    for (const card of cardPayments) {
      let best = null
      for (const bank of bankDebits) {
        const result = scoreSettlementMatch(card, bank)
        if (result && (!best || result.score > best.score)) best = { ...result, bankTxn: bank }
      }
      if (best && best.score >= 50) out.push({ card, ...best })
    }
    return out
  }, [transactions])

  const settlementCandidateByCardId = useMemo(() => {
    const m = new Map()
    for (const sc of settlementCandidates) m.set(sc.card.id, sc)
    return m
  }, [settlementCandidates])

  // A fingerprintLoose shared by more than one still-active row is a real
  // signal of a possible duplicate — surfaced here in Exceptions, not just
  // silently treated as another low-score expense candidate.
  const duplicateLooseFingerprints = useMemo(() => {
    const counts = new Map()
    for (const t of transactions) {
      if (t.status === 'ignored' || t.status === 'matched') continue
      counts.set(t.fingerprintLoose, (counts.get(t.fingerprintLoose) || 0) + 1)
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([fp]) => fp))
  }, [transactions])

  function categoryFor(txn) {
    if (txn.status !== 'suggested') return null
    return classifyReviewCategory(txn, { hasDuplicate: duplicateLooseFingerprints.has(txn.fingerprintLoose) })
  }

  function unresolvedDuplicateFlag(txn) {
    return txn.duplicateStatus && ['possible_duplicate', 'needs_review'].includes(txn.duplicateStatus) && !txn.duplicateReviewedAt
  }

  // One short line for the list card — never a bare score, per the
  // explainable-suggestions requirement, but short enough to fit a card
  // without pushing the amount/status off screen on a phone.
  function shortReasonFor(txn) {
    const sc = settlementCandidateByCardId.get(txn.id)
    if (sc) return sc.reasons[0]
    if (unresolvedDuplicateFlag(txn)) return txn.duplicateReason
    if (txn.matchReasons?.length) return txn.matchReasons[0]
    return null
  }

  function needsAction(txn) {
    if (txn.status === 'suggested') return true
    if (settlementCandidateByCardId.has(txn.id)) return true
    if (unresolvedDuplicateFlag(txn)) return true
    return false
  }

  function isException(txn) {
    if (txn.status === 'ignored' || txn.status === 'matched') return false
    const cat = categoryFor(txn)
    if (cat && cat !== 'possible_expense') return true
    if (settlementCandidateByCardId.has(txn.id)) return true
    if (unresolvedDuplicateFlag(txn)) return true
    return false
  }

  // Workload summary cards — the "what's left to do" view, not just a
  // financial total.
  const counts = useMemo(() => {
    const needsActionCount = transactions.filter(needsAction).length
    const matchedCount = transactions.filter(t => t.status === 'matched').length
    const exceptionsCount = transactions.filter(isException).length
    const missingReceiptCount = expenses.filter(e => e.reconciliationStatus === 'created_from_statement' && e.receiptStatus === 'missing').length
    return {
      needsAction: needsActionCount,
      statementTransactions: transactions.length,
      matched: matchedCount,
      missingReceipt: missingReceiptCount,
      exceptions: exceptionsCount,
      cardSettlements: settlementCandidates.length,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, expenses, settlementCandidates, duplicateLooseFingerprints])

  const filteredRows = useMemo(() => {
    let rows = transactions
    if (topTab === 'Needs Action') rows = rows.filter(needsAction)
    else if (topTab === 'Matched') rows = rows.filter(t => t.status === 'matched')
    else if (topTab === 'Exceptions') rows = rows.filter(isException)
    // 'All' keeps everything, including ignored — Tiffany can still find and Undo an ignored row from here.

    if (topTab === 'Exceptions' && exceptionFilter !== 'all') {
      rows = rows.filter(t => categoryFor(t) === exceptionFilter || (exceptionFilter === 'possible_settlement' && settlementCandidateByCardId.has(t.id)))
    }
    if (sourceTypeFilter !== 'all') {
      rows = rows.filter(t => accountOf(t.paymentAccountId)?.sourceType === sourceTypeFilter)
    }
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      rows = rows.filter(t => (t.merchantRaw || '').toLowerCase().includes(q))
    }

    // Default sort per the research: Needs Action first, larger amounts and
    // older dates surfaced before routine high-score candidates — never
    // just "100-score suggestions on top."
    return [...rows].sort((a, b) => {
      const aAction = needsAction(a) ? 0 : 1
      const bAction = needsAction(b) ? 0 : 1
      if (aAction !== bAction) return aAction - bAction
      const aException = isException(a) ? 0 : 1
      const bException = isException(b) ? 0 : 1
      if (aException !== bException) return aException - bException
      if ((b.settlementAmount || 0) !== (a.settlementAmount || 0)) return (b.settlementAmount || 0) - (a.settlementAmount || 0)
      return (a.transactionDate || '').localeCompare(b.transactionDate || '')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, accounts, topTab, exceptionFilter, sourceTypeFilter, searchText, settlementCandidateByCardId, duplicateLooseFingerprints])

  const selected = filteredRows.find(t => t.id === selectedId) || null
  const selectedSettlement = selected ? settlementCandidateByCardId.get(selected.id) : null
  const selectedExpense = selected?.matchedExpenseIds?.[0] ? expenses.find(e => e.id === selected.matchedExpenseIds[0]) : null
  const selectedCategory = selected ? categoryFor(selected) : null

  async function confirmMatch(txn, expenseIdOverride) {
    const expenseId = expenseIdOverride || txn.matchedExpenseIds?.[0]
    if (!expenseId) return
    const expense = expenses.find(e => e.id === expenseId)
    if (!expense) return
    if (expense.matchedPaymentTransactionId && expense.matchedPaymentTransactionId !== txn.id) {
      alert('That expense is already matched to a different transaction. Unmatch it first, or choose a different expense.')
      return
    }
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      status: 'matched',
      matchedExpenseIds: [expenseId],
      updatedAt: serverTimestamp(),
    })
    await updateDoc(doc(db, 'expenses', expenseId), {
      matchedPaymentTransactionId: txn.id,
      matchedPaymentAccountId: txn.paymentAccountId,
      settlementAmount: txn.settlementAmount,
      settlementCurrency: txn.settlementCurrency,
      settlementStatus: 'confirmed',
      sourceStatementImportId: txn.importId || null,
      sourceStatementRowText: txn.rawRowText || null,
    })
    await logAction(txn, expenseId, 'matched', { status: txn.status }, { status: 'matched' })
    setBusyId(null)
    setChosenExpenseId('')
  }

  async function ignoreTxn(txn) {
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), { status: 'ignored', updatedAt: serverTimestamp() })
    await logAction(txn, null, 'ignored', { status: txn.status }, { status: 'ignored' })
    setBusyId(null)
  }

  async function undoIgnore(txn) {
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), { status: 'unmatched', updatedAt: serverTimestamp() })
    await logAction(txn, null, 'undo_ignore', { status: txn.status }, { status: 'unmatched' })
    setBusyId(null)
  }

  // Reverts a confirmed Match, a statement-created Expense, or a settlement
  // link — restoring both sides so nothing points at a stale relationship.
  // The AI's suggestion is never treated as final; this is how Tiffany
  // reopens something she confirmed by mistake.
  async function unmatchTxn(txn) {
    setBusyId(txn.id)
    if (txn.matchedExpenseIds?.[0]) {
      await updateDoc(doc(db, 'expenses', txn.matchedExpenseIds[0]), {
        matchedPaymentTransactionId: null,
        matchedPaymentAccountId: null,
        settlementAmount: null,
        settlementCurrency: null,
        settlementStatus: 'unsettled',
      })
    }
    if (txn.settlementGroupId) {
      const partner = transactions.find(t => t.id !== txn.id && t.settlementGroupId === txn.settlementGroupId)
      if (partner) await updateDoc(doc(db, 'paymentTransactions', partner.id), { settlementGroupId: null, matchStatus: null, linkedTransactionIds: [], status: 'unmatched', updatedAt: serverTimestamp() })
    }
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      status: 'unmatched',
      matchedExpenseIds: [],
      settlementGroupId: null,
      matchStatus: null,
      linkedTransactionIds: [],
      confidenceScore: null,
      matchReasons: [],
      updatedAt: serverTimestamp(),
    })
    await logAction(txn, null, 'unmatched', { status: txn.status }, { status: 'unmatched' })
    setBusyId(null)
  }

  async function markAs(txn, transactionType) {
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      transactionType,
      status: 'ignored',
      updatedAt: serverTimestamp(),
    })
    await logAction(txn, null, `marked_${transactionType}`, { transactionType: txn.transactionType }, { transactionType })
    setBusyId(null)
  }

  async function createExpenseFromTxn(txn, { force = false } = {}) {
    if (CREATE_EXPENSE_BLOCKED_TYPES.includes(txn.transactionType) && !force) return
    setBusyId(txn.id)
    const account = accountOf(txn.paymentAccountId)
    const source = account?.sourceType === 'credit_card' ? 'credit_card_statement' : 'bank_statement'
    const expenseRef = await addDoc(collection(db, 'expenses'), {
      userId: auth.currentUser.uid,
      userEmail: auth.currentUser.email,
      projectId: activeProject.id,
      date: txn.transactionDate || txn.postDate || '',
      vendor: txn.merchantNormalized ? txn.merchantNormalized.replace(/\b\w/g, c => c.toUpperCase()) : txn.merchantRaw,
      amount: txn.settlementAmount,
      currency: txn.settlementCurrency,
      category: 'Other',
      notes: `Statement description: "${txn.merchantRaw}". Expense created from statement — receipt missing.`,
      paymentMethod: '',
      images: [],
      receiptStatus: 'missing',
      reconciliationStatus: 'created_from_statement',
      source,
      sourceStatementImportId: txn.importId || null,
      sourceStatementRowText: txn.rawRowText || null,
      settlementAmount: txn.settlementAmount,
      settlementCurrency: txn.settlementCurrency,
      settlementStatus: 'confirmed',
      matchedPaymentTransactionId: txn.id,
      matchedPaymentAccountId: txn.paymentAccountId,
      createdAt: serverTimestamp(),
    })
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      status: 'matched',
      matchedExpenseIds: [expenseRef.id],
      updatedAt: serverTimestamp(),
    })
    await logAction(txn, expenseRef.id, 'expense_created', null, { expenseId: expenseRef.id })
    setBusyId(null)
  }

  async function linkSettlement(card, bankTxn) {
    setBusyId(card.id)
    const groupId = doc(collection(db, 'reconciliationActions')).id
    await updateDoc(doc(db, 'paymentTransactions', card.id), {
      settlementGroupId: groupId,
      matchStatus: 'linked_settlement',
      linkedTransactionIds: [bankTxn.id],
      status: 'matched',
      updatedAt: serverTimestamp(),
    })
    await updateDoc(doc(db, 'paymentTransactions', bankTxn.id), {
      settlementGroupId: groupId,
      matchStatus: 'linked_settlement',
      linkedTransactionIds: [card.id],
      status: 'matched',
      updatedAt: serverTimestamp(),
    })
    await logAction(card, null, 'settlement_linked', null, { settlementGroupId: groupId, linkedTransactionId: bankTxn.id })
    setBusyId(null)
    setPickingSettlement(false)
    setChosenCounterpart('')
  }

  async function resolveDuplicate(txn, newStatus) {
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      duplicateStatus: newStatus,
      duplicateReviewedBy: auth.currentUser.email,
      duplicateReviewedAt: serverTimestamp(),
      ...(newStatus === 'confirmed_duplicate' ? { status: 'ignored' } : {}),
      updatedAt: serverTimestamp(),
    })
    setBusyId(null)
  }

  function dismissDuplicateWarning(txn) {
    setBusyId(txn.id)
    updateDoc(doc(db, 'paymentTransactions', txn.id), {
      duplicateReviewedBy: auth.currentUser.email,
      duplicateReviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }).finally(() => setBusyId(null))
  }

  // Any active, unlinked transaction on a different account can be picked
  // as a manual settlement counterpart — not limited to the auto-detected
  // card-payment/bank-debit shape, since the user may be linking a case the
  // heuristic missed.
  const settlementCounterpartOptions = txn => transactions.filter(t =>
    t.id !== txn.id && !t.settlementGroupId && t.paymentAccountId !== txn.paymentAccountId &&
    ['unmatched', 'suggested'].includes(t.status)
  )

  if (!activeProject) return <div className="page"><p className="loading">Loading…</p></div>

  return (
    <div className="page">
      <ProjectBanner />
      <div className="card-header" style={{ marginBottom: 16 }}>
        <h2 style={{ marginBottom: 0 }}>Reconciliation</h2>
        <button className="btn-ghost" onClick={runMatching} disabled={matching}>
          {matching ? 'Matching…' : 'Run Matching'}
        </button>
      </div>

      <div className="recon-cards">
        <button className={`recon-card ${topTab === 'Needs Action' ? 'is-active' : ''}`} onClick={() => setTopTab('Needs Action')}>
          <span className="recon-card-value">{counts.needsAction}</span>
          <span className="recon-card-label">Needs Action</span>
        </button>
        <button className={`recon-card ${topTab === 'All' ? 'is-active' : ''}`} onClick={() => setTopTab('All')}>
          <span className="recon-card-value">{counts.statementTransactions}</span>
          <span className="recon-card-label">Statement Transactions</span>
        </button>
        <button className={`recon-card ${topTab === 'Matched' ? 'is-active' : ''}`} onClick={() => setTopTab('Matched')}>
          <span className="recon-card-value">{counts.matched}</span>
          <span className="recon-card-label">Matched</span>
        </button>
        <Link to="/expenses" className="recon-card">
          <span className="recon-card-value">{counts.missingReceipt}</span>
          <span className="recon-card-label">Missing Receipt</span>
        </Link>
        <button className={`recon-card ${topTab === 'Exceptions' && exceptionFilter === 'all' ? 'is-active' : ''}`} onClick={() => { setTopTab('Exceptions'); setExceptionFilter('all') }}>
          <span className="recon-card-value">{counts.exceptions}</span>
          <span className="recon-card-label">Needs Review</span>
        </button>
        <button className={`recon-card ${topTab === 'Exceptions' && exceptionFilter === 'possible_settlement' ? 'is-active' : ''}`} onClick={() => { setTopTab('Exceptions'); setExceptionFilter('possible_settlement') }}>
          <span className="recon-card-value">{counts.cardSettlements}</span>
          <span className="recon-card-label">Card Settlements</span>
        </button>
      </div>

      <div className="filter-row" style={{ marginBottom: 12 }}>
        {TOP_TABS.map(t => (
          <button key={t} className={t === topTab ? 'btn-primary btn-small' : 'btn-ghost btn-small'} onClick={() => setTopTab(t)}>{t}</button>
        ))}
        <select value={sourceTypeFilter} onChange={e => setSourceTypeFilter(e.target.value)}>
          <option value="all">All sources</option>
          <option value="bank">Bank</option>
          <option value="credit_card">Credit Card</option>
        </select>
        <input className="filter-search" placeholder="Search merchant…" value={searchText} onChange={e => setSearchText(e.target.value)} />
      </div>

      {topTab === 'Exceptions' && (
        <div className="filter-row" style={{ marginBottom: 12 }}>
          {EXCEPTION_FILTERS.map(f => (
            <button key={f.value} className={f.value === exceptionFilter ? 'btn-primary btn-small' : 'btn-ghost btn-small'} onClick={() => setExceptionFilter(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      )}

      {filteredRows.length === 0 ? (
        <p className="empty">Nothing here.</p>
      ) : (
        <div className="recon-layout">
          <div className={`recon-list ${selected ? 'has-selection' : ''}`}>
            {filteredRows.map(txn => {
              const cat = categoryFor(txn)
              const sc = settlementCandidateByCardId.get(txn.id)
              return (
                <button key={txn.id} className={`recon-row ${txn.id === selectedId ? 'is-selected' : ''}`} onClick={() => setSelectedId(txn.id)}>
                  <div className="recon-row-top">
                    <span className="recon-row-date">{txn.transactionDate || txn.rawDateText}</span>
                    <span className="recon-row-amount">{txn.settlementCurrency} {txn.settlementAmount?.toFixed(2)}</span>
                  </div>
                  <div className="recon-row-merchant">{txn.merchantRaw || '(no description)'}</div>
                  <div className="recon-row-source">
                    {accountSourceLabel(txn.paymentAccountId)} · {accountLabel(txn.paymentAccountId)}{accountTail(txn.paymentAccountId) && ` ${accountTail(txn.paymentAccountId)}`}
                  </div>
                  <div className="recon-row-tags">
                    {txn.status === 'matched' && <span className="badge badge-office">Matched</span>}
                    {txn.status === 'ignored' && <span className="badge">Ignored</span>}
                    {sc && <span className="badge badge-warning">Possible Settlement</span>}
                    {cat && cat !== 'possible_expense' && <span className="badge badge-warning">{REVIEW_CATEGORY_LABELS[cat]}</span>}
                    {cat === 'possible_expense' && <span className="badge badge-office">{txn.confidenceScore} pts</span>}
                    {unresolvedDuplicateFlag(txn) && <span className="badge badge-warning">{DUPLICATE_STATUS_LABELS[txn.duplicateStatus]}</span>}
                  </div>
                  {shortReasonFor(txn) && <div className="recon-row-reason">{shortReasonFor(txn)}</div>}
                </button>
              )
            })}
          </div>

          <div className={`recon-detail ${selected ? 'has-selection' : ''}`}>
            {!selected ? (
              <p className="empty">Select a transaction to see its details.</p>
            ) : (
              <>
                <button className="btn-ghost btn-small mobile-only" style={{ marginBottom: 12 }} onClick={() => setSelectedId(null)}>← Back to list</button>

                <div className="card-header">
                  <h3>{selected.merchantRaw || '(no description)'}</h3>
                  <span className="recon-detail-amount">{selected.settlementCurrency} {selected.settlementAmount?.toFixed(2)}</span>
                </div>

                <div className="recon-detail-section">
                  <div className="recon-detail-label">Source</div>
                  <p>{accountSourceLabel(selected.paymentAccountId)} · {accountLabel(selected.paymentAccountId)}</p>
                </div>

                <div className="recon-detail-section">
                  <div className="recon-detail-label">Transaction</div>
                  <p>
                    Transaction date: {selected.transactionDate || selected.rawDateText || '—'}<br />
                    {selected.postDate && <>Posting date: {selected.postDate}<br /></>}
                    Direction: {selected.direction}<br />
                    {selected.balanceAfter != null && <>Balance after: {selected.balanceAfter.toFixed(2)}<br /></>}
                    Type: {selected.transactionType}
                  </p>
                </div>

                {unresolvedDuplicateFlag(selected) && (
                  <div className="recon-detail-section">
                    <div className="recon-detail-label">Duplicate check</div>
                    <p><span className="badge badge-warning">{DUPLICATE_STATUS_LABELS[selected.duplicateStatus]}</span></p>
                    <p className="hint">{selected.duplicateReason}</p>
                    <div className="action-row">
                      <button className="btn-small" disabled={busyId === selected.id} onClick={() => resolveDuplicate(selected, 'verified_separate')}>Keep as Separate</button>
                      <button className="btn-small btn-danger" disabled={busyId === selected.id} onClick={() => resolveDuplicate(selected, 'confirmed_duplicate')}>Confirm Duplicate</button>
                      <button className="btn-small btn-ghost" disabled={busyId === selected.id} onClick={() => dismissDuplicateWarning(selected)}>Ignore Warning</button>
                    </div>
                  </div>
                )}

                {selectedSettlement ? (
                  <div className="recon-detail-section">
                    <div className="recon-detail-label">Possible Credit Card Settlement</div>
                    <p><strong>Card payment:</strong> {selectedSettlement.card.merchantRaw} — {selectedSettlement.card.settlementCurrency} {selectedSettlement.card.settlementAmount.toFixed(2)} on {selectedSettlement.card.transactionDate} ({accountLabel(selectedSettlement.card.paymentAccountId)})</p>
                    <p><strong>Bank debit:</strong> {selectedSettlement.bankTxn.merchantRaw} — {selectedSettlement.bankTxn.settlementCurrency} {selectedSettlement.bankTxn.settlementAmount.toFixed(2)} on {selectedSettlement.bankTxn.transactionDate} ({accountLabel(selectedSettlement.bankTxn.paymentAccountId)})</p>
                    <p className="hint">{selectedSettlement.reasons.join(' · ')} · Score {selectedSettlement.score}</p>
                    <p className="hint">This links a credit-card repayment, not a business expense — it will never be counted in the Expense total.</p>
                    <div className="action-row">
                      <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => ignoreTxn(selected)}>Not Related</button>
                    </div>
                    <div className="recon-sticky-actions">
                      <button className="btn-primary" disabled={busyId === selected.id} onClick={() => linkSettlement(selectedSettlement.card, selectedSettlement.bankTxn)}>Link Settlement</button>
                    </div>
                  </div>
                ) : selected.status === 'matched' ? (
                  <div className="recon-detail-section">
                    <div className="recon-detail-label">Matched</div>
                    {selectedExpense ? (
                      <>
                        <p>{selectedExpense.date} · {selectedExpense.vendor} · {selectedExpense.currency} {parseFloat(selectedExpense.amount).toFixed(2)} · {selectedExpense.category}</p>
                        {selectedExpense.reconciliationStatus === 'created_from_statement' && selectedExpense.receiptStatus === 'missing' && (
                          <p className="badge badge-warning">Created from statement — receipt missing</p>
                        )}
                        {selectedExpense.images?.[0] && (
                          selectedExpense.images[0].name?.toLowerCase().endsWith('.pdf')
                            ? <p><a href={selectedExpense.images[0].url} target="_blank" rel="noreferrer">View receipt (PDF)</a></p>
                            : <img src={selectedExpense.images[0].url} alt="Receipt" className="recon-receipt-thumb" />
                        )}
                      </>
                    ) : selected.settlementGroupId ? (
                      <p className="hint">Linked as a credit-card settlement — not a business expense.</p>
                    ) : (
                      <p className="hint">Matched, but the linked Expense could not be found (it may have been deleted).</p>
                    )}
                    <div className="action-row recon-sticky-actions">
                      <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => unmatchTxn(selected)}>Unmatch</button>
                    </div>
                  </div>
                ) : selected.status === 'ignored' ? (
                  <div className="recon-detail-section">
                    <div className="recon-detail-label">Ignored</div>
                    <div className="action-row recon-sticky-actions">
                      <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => undoIgnore(selected)}>Undo</button>
                    </div>
                  </div>
                ) : (
                  <div className="recon-detail-section">
                    <div className="recon-detail-label">
                      {selectedCategory ? REVIEW_CATEGORY_LABELS[selectedCategory] : 'No suggestion yet'}
                    </div>
                    {selectedExpense && (
                      <>
                        <p>Suggested Expense: {selectedExpense.date} · {selectedExpense.vendor} · {selectedExpense.currency} {parseFloat(selectedExpense.amount).toFixed(2)} · {selectedExpense.category}</p>
                        {selectedExpense.images?.[0] && !selectedExpense.images[0].name?.toLowerCase().endsWith('.pdf') && (
                          <img src={selectedExpense.images[0].url} alt="Receipt" className="recon-receipt-thumb" />
                        )}
                      </>
                    )}
                    {selected.confidenceScore != null && <p><strong>Match score: {selected.confidenceScore}</strong></p>}
                    {selected.matchReasons?.length > 0 && (
                      <ul className="recon-reasons">
                        {selected.matchReasons.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    )}

                    {/* Secondary actions scroll with the page — only the one
                        primary action below is pinned, per the mobile
                        guidance that a phone screen should have exactly one
                        fixed CTA, not a wall of equally-weighted buttons. */}
                    <div className="action-row" style={{ flexWrap: 'wrap' }}>
                      {selectedExpense && !CREATE_EXPENSE_BLOCKED_TYPES.includes(selected.transactionType) && (
                        <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => createExpenseFromTxn(selected)}>Create Expense</button>
                      )}
                      {CREATE_EXPENSE_BLOCKED_TYPES.includes(selected.transactionType) && (
                        <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => {
                          if (confirm(`This transaction was classified as ${selected.transactionType}, which is not normally a business expense. Create an Expense from it anyway?`)) createExpenseFromTxn(selected, { force: true })
                        }}>Create Expense Anyway</button>
                      )}
                      {selectedCategory !== 'possible_refund' && (
                        <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => markAs(selected, 'refund')}>Mark as Refund</button>
                      )}
                      {selectedCategory !== 'possible_transfer' && (
                        <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => markAs(selected, 'transfer')}>Mark as Transfer</button>
                      )}
                      <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => setPickingSettlement(true)}>Link Settlement</button>
                      <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => ignoreTxn(selected)}>Ignore</button>
                    </div>

                    <div className="filter-row" style={{ marginTop: 10 }}>
                      <select value={chosenExpenseId} onChange={e => setChosenExpenseId(e.target.value)}>
                        <option value="">Find another expense…</option>
                        {expenses.filter(e => !e.matchedPaymentTransactionId || e.id === selectedExpense?.id).map(e => (
                          <option key={e.id} value={e.id}>{e.date} · {e.vendor} · {e.currency} {parseFloat(e.amount).toFixed(2)}</option>
                        ))}
                      </select>
                      <button className="btn-small" disabled={busyId === selected.id || !chosenExpenseId} onClick={() => confirmMatch(selected, chosenExpenseId)}>Confirm Chosen Expense</button>
                    </div>

                    {pickingSettlement && (
                      <div className="filter-row" style={{ marginTop: 10 }}>
                        <select value={chosenCounterpart} onChange={e => setChosenCounterpart(e.target.value)}>
                          <option value="">Choose the matching bank/card transaction…</option>
                          {settlementCounterpartOptions(selected).map(t => (
                            <option key={t.id} value={t.id}>{accountLabel(t.paymentAccountId)} · {t.transactionDate} · {t.settlementCurrency} {t.settlementAmount.toFixed(2)}</option>
                          ))}
                        </select>
                        <button className="btn-small" disabled={busyId === selected.id || !chosenCounterpart} onClick={() => linkSettlement(selected, transactions.find(t => t.id === chosenCounterpart))}>Link</button>
                        <button className="btn-small btn-ghost" onClick={() => setPickingSettlement(false)}>Cancel</button>
                      </div>
                    )}

                    <div className="recon-sticky-actions">
                      {selectedExpense ? (
                        <button className="btn-primary" disabled={busyId === selected.id} onClick={() => confirmMatch(selected)}>Confirm Match</button>
                      ) : !CREATE_EXPENSE_BLOCKED_TYPES.includes(selected.transactionType) ? (
                        <button className="btn-primary" disabled={busyId === selected.id} onClick={() => createExpenseFromTxn(selected)}>Create Expense</button>
                      ) : (
                        <button className="btn-primary" disabled={busyId === selected.id} onClick={() => ignoreTxn(selected)}>Ignore</button>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
