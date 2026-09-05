import { useState, useEffect, useMemo } from 'react'
import { collection, query, where, onSnapshot, doc, updateDoc, addDoc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import { scoreExpenseMatch, scoreSettlementMatch, classifyReviewCategory, CREATE_EXPENSE_BLOCKED_TYPES } from '../lib/paymentMatching'

const TABS = ['Auto Suggest', 'Needs Review', 'Credit Card Repayment Link', 'Ignored']

const REVIEW_CATEGORY_LABELS = {
  possible_expense: 'Possible Expense',
  possible_settlement: 'Possible Credit Card Settlement',
  possible_refund: 'Possible Refund',
  possible_transfer: 'Possible Transfer',
  possible_duplicate: 'Possible Duplicate',
  unclear: 'Unclear',
}

export default function Reconciliation() {
  const { activeProject } = useProject()
  const [transactions, setTransactions] = useState([])
  const [expenses, setExpenses] = useState([])
  const [accounts, setAccounts] = useState([])
  const [tab, setTab] = useState('Auto Suggest')
  const [matching, setMatching] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [chosenExpense, setChosenExpense] = useState({}) // txnId -> expenseId, for "Choose Another Expense"
  const [settlementPickerFor, setSettlementPickerFor] = useState(null) // txnId currently picking a manual settlement counterpart
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

  const accountLabel = id => accounts.find(a => a.id === id)?.label || '—'
  const accountSourceLabel = id => {
    const type = accounts.find(a => a.id === id)?.sourceType
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

  // A fingerprintLoose shared by more than one still-active row is a real
  // signal of a possible duplicate — surfaced in Needs Review rather than
  // silently treated as just another low-score expense candidate.
  const duplicateLooseFingerprints = useMemo(() => {
    const counts = new Map()
    for (const t of transactions) {
      if (t.status === 'ignored' || t.status === 'matched') continue
      counts.set(t.fingerprintLoose, (counts.get(t.fingerprintLoose) || 0) + 1)
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([fp]) => fp))
  }, [transactions])

  function categoryFor(txn) {
    return classifyReviewCategory(txn, { hasDuplicate: duplicateLooseFingerprints.has(txn.fingerprintLoose) })
  }

  async function confirmMatch(txn, expenseIdOverride) {
    const expenseId = expenseIdOverride || txn.matchedExpenseIds?.[0]
    if (!expenseId) return
    const expense = expenses.find(e => e.id === expenseId)
    if (!expense) return
    if (expense.matchedPaymentTransactionId && expense.matchedPaymentTransactionId !== txn.id) {
      alert('That expense is already matched to a different transaction. Unlink it first from Payment Sources, or choose a different expense.')
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
  }

  async function ignoreTxn(txn) {
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), { status: 'ignored', updatedAt: serverTimestamp() })
    await logAction(txn, null, 'ignored', { status: txn.status }, { status: 'ignored' })
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
    const account = accounts.find(a => a.id === txn.paymentAccountId)
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
    setSettlementPickerFor(null)
    setChosenCounterpart('')
  }

  const suggested = transactions.filter(t => t.status === 'suggested')
  const autoSuggested = suggested.filter(t => (t.confidenceScore || 0) >= 90)
  const needsReview = suggested.filter(t => (t.confidenceScore || 0) < 90)
  const ignored = transactions.filter(t => t.status === 'ignored')

  // Any active, unlinked transaction can be picked as a manual settlement
  // counterpart — not limited to the auto-detected card-payment/bank-debit
  // shape, since the user may be linking a case the heuristic missed.
  const settlementCounterpartOptions = txn => transactions.filter(t =>
    t.id !== txn.id && !t.settlementGroupId && t.paymentAccountId !== txn.paymentAccountId &&
    ['unmatched', 'suggested'].includes(t.status)
  )

  const listForTab = {
    'Auto Suggest': autoSuggested,
    'Needs Review': needsReview,
    'Credit Card Repayment Link': null, // rendered separately below
    'Ignored': ignored,
  }[tab]

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

      <div className="filter-row" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t} className={t === tab ? 'btn-primary btn-small' : 'btn-ghost btn-small'} onClick={() => setTab(t)}>
            {t}
            {t === 'Auto Suggest' && ` (${autoSuggested.length})`}
            {t === 'Needs Review' && ` (${needsReview.length})`}
            {t === 'Credit Card Repayment Link' && ` (${settlementCandidates.length})`}
            {t === 'Ignored' && ` (${ignored.length})`}
          </button>
        ))}
      </div>

      {tab === 'Credit Card Repayment Link' ? (
        settlementCandidates.length === 0
          ? <p className="empty">No card-payment-to-bank-debit candidates found. Run Matching after importing both a credit card and bank statement.</p>
          : settlementCandidates.map(({ card, bankTxn, score, reasons }) => (
              <div key={card.id} className="card">
                <div className="card-header"><h3>Possible Credit Card Repayment Link</h3><span className="badge badge-office">{score} pts</span></div>
                <p><strong>Card payment:</strong> {card.merchantRaw} — {card.settlementCurrency} {card.settlementAmount.toFixed(2)} on {card.transactionDate} ({accountLabel(card.paymentAccountId)})</p>
                <p><strong>Bank debit:</strong> {bankTxn.merchantRaw} — {bankTxn.settlementCurrency} {bankTxn.settlementAmount.toFixed(2)} on {bankTxn.transactionDate} ({accountLabel(bankTxn.paymentAccountId)})</p>
                <p className="hint">{reasons.join(' · ')}</p>
                <p className="hint">This links a credit-card repayment, not a business expense — it will never be counted in the Expense total.</p>
                <div className="action-row" style={{ marginTop: 12 }}>
                  <button className="btn-primary" disabled={busyId === card.id} onClick={() => linkSettlement(card, bankTxn)}>Link Repayment</button>
                  <button className="btn-ghost" disabled={busyId === card.id} onClick={() => ignoreTxn(card)}>Not Related</button>
                </div>
              </div>
            ))
      ) : listForTab.length === 0 ? (
        <p className="empty">Nothing here.</p>
      ) : (
        listForTab.map(txn => {
          const category = tab === 'Needs Review' ? categoryFor(txn) : null
          const expense = txn.matchedExpenseIds?.[0] ? expenses.find(e => e.id === txn.matchedExpenseIds[0]) : null
          const canCreateExpense = !CREATE_EXPENSE_BLOCKED_TYPES.includes(txn.transactionType)
          const counterpartOptions = tab === 'Needs Review' ? settlementCounterpartOptions(txn) : []
          return (
            <div key={txn.id} className="card">
              <div className="card-header">
                <h3>{txn.merchantRaw || '(no description)'}</h3>
                {txn.confidenceScore != null && <span className="badge badge-office">{txn.confidenceScore} pts</span>}
              </div>
              <p>
                {accountSourceLabel(txn.paymentAccountId)} · {accountLabel(txn.paymentAccountId)} · {txn.transactionDate || txn.rawDateText}
                {txn.postDate && ` (posted ${txn.postDate})`} · {txn.settlementCurrency} {txn.settlementAmount.toFixed(2)} · {txn.transactionType}
              </p>
              {category && <p><span className="badge badge-office">{REVIEW_CATEGORY_LABELS[category]}</span></p>}
              {expense && (
                <p className="hint">
                  Suggested Expense: {expense.date} · {expense.vendor} · {expense.currency} {parseFloat(expense.amount).toFixed(2)} · {expense.category}
                </p>
              )}
              {txn.matchReasons?.length > 0 && <p className="hint">{txn.matchReasons.join(' · ')}</p>}
              {tab !== 'Ignored' && (
                <>
                  <div className="action-row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                    {expense && <button className="btn-primary" disabled={busyId === txn.id} onClick={() => confirmMatch(txn)}>Confirm Match</button>}
                    {canCreateExpense && <button className="btn-ghost" disabled={busyId === txn.id} onClick={() => createExpenseFromTxn(txn)}>Create Expense</button>}
                    {tab === 'Needs Review' && !canCreateExpense && (
                      <button className="btn-ghost" disabled={busyId === txn.id} onClick={() => {
                        if (confirm(`This transaction was classified as ${txn.transactionType}, which is not normally a business expense. Create an Expense from it anyway?`)) createExpenseFromTxn(txn, { force: true })
                      }}>Create Expense Anyway</button>
                    )}
                    {tab === 'Needs Review' && category === 'possible_settlement' && (
                      <button className="btn-ghost" disabled={busyId === txn.id} onClick={() => { setSettlementPickerFor(txn.id); setChosenCounterpart('') }}>
                        Link as Credit Card Settlement
                      </button>
                    )}
                    {tab === 'Needs Review' && category !== 'possible_refund' && (
                      <button className="btn-ghost" disabled={busyId === txn.id} onClick={() => markAs(txn, 'refund')}>Mark as Refund</button>
                    )}
                    {tab === 'Needs Review' && category !== 'possible_transfer' && (
                      <button className="btn-ghost" disabled={busyId === txn.id} onClick={() => markAs(txn, 'transfer')}>Mark as Transfer</button>
                    )}
                    <button className="btn-ghost" disabled={busyId === txn.id} onClick={() => ignoreTxn(txn)}>Ignore</button>
                  </div>

                  {tab === 'Needs Review' && (
                    <div className="filter-row" style={{ marginTop: 8 }}>
                      <select
                        value={chosenExpense[txn.id] ?? expense?.id ?? ''}
                        onChange={e => setChosenExpense(prev => ({ ...prev, [txn.id]: e.target.value }))}
                      >
                        <option value="">Choose another expense…</option>
                        {expenses.filter(e => !e.matchedPaymentTransactionId || e.id === expense?.id).map(e => (
                          <option key={e.id} value={e.id}>{e.date} · {e.vendor} · {e.currency} {parseFloat(e.amount).toFixed(2)}</option>
                        ))}
                      </select>
                      <button
                        className="btn-small"
                        disabled={busyId === txn.id || !chosenExpense[txn.id]}
                        onClick={() => confirmMatch(txn, chosenExpense[txn.id])}
                      >
                        Confirm Chosen Expense
                      </button>
                    </div>
                  )}

                  {settlementPickerFor === txn.id && (
                    <div className="filter-row" style={{ marginTop: 8 }}>
                      <select value={chosenCounterpart} onChange={e => setChosenCounterpart(e.target.value)}>
                        <option value="">Choose the matching bank/card transaction…</option>
                        {counterpartOptions.map(t => (
                          <option key={t.id} value={t.id}>
                            {accountLabel(t.paymentAccountId)} · {t.transactionDate} · {t.settlementCurrency} {t.settlementAmount.toFixed(2)}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn-small"
                        disabled={busyId === txn.id || !chosenCounterpart}
                        onClick={() => linkSettlement(txn, transactions.find(t => t.id === chosenCounterpart))}
                      >
                        Link
                      </button>
                      <button className="btn-small btn-ghost" onClick={() => setSettlementPickerFor(null)}>Cancel</button>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
