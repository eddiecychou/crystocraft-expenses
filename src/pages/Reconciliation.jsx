import { useState, useEffect, useMemo } from 'react'
import { collection, query, where, onSnapshot, doc, updateDoc, addDoc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import { scoreExpenseMatch, scoreSettlementMatch } from '../lib/paymentMatching'

const TABS = ['Auto-suggested', 'Needs Review', 'Card Settlements', 'Ignored']

export default function Reconciliation() {
  const { activeProject } = useProject()
  const [transactions, setTransactions] = useState([])
  const [expenses, setExpenses] = useState([])
  const [accounts, setAccounts] = useState([])
  const [tab, setTab] = useState('Auto-suggested')
  const [matching, setMatching] = useState(false)
  const [busyId, setBusyId] = useState(null)

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

  async function confirmMatch(txn) {
    setBusyId(txn.id)
    const expenseId = txn.matchedExpenseIds[0]
    const expense = expenses.find(e => e.id === expenseId)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), { status: 'matched', updatedAt: serverTimestamp() })
    await updateDoc(doc(db, 'expenses', expenseId), {
      matchedPaymentTransactionId: txn.id,
      matchedPaymentAccountId: txn.paymentAccountId,
      settlementAmount: txn.settlementAmount,
      settlementCurrency: txn.settlementCurrency,
      settlementStatus: 'confirmed',
    })
    await addDoc(collection(db, 'reconciliationActions'), {
      userId: auth.currentUser.uid,
      projectId: activeProject.id,
      paymentTransactionId: txn.id,
      expenseId,
      actionType: 'matched',
      beforeState: { status: txn.status },
      afterState: { status: 'matched' },
      createdAt: serverTimestamp(),
      actor: { uid: auth.currentUser.uid, email: auth.currentUser.email },
    })
    setBusyId(null)
  }

  async function ignoreTxn(txn) {
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), { status: 'ignored', updatedAt: serverTimestamp() })
    await addDoc(collection(db, 'reconciliationActions'), {
      userId: auth.currentUser.uid,
      projectId: activeProject.id,
      paymentTransactionId: txn.id,
      expenseId: null,
      actionType: 'ignored',
      beforeState: { status: txn.status },
      afterState: { status: 'ignored' },
      createdAt: serverTimestamp(),
      actor: { uid: auth.currentUser.uid, email: auth.currentUser.email },
    })
    setBusyId(null)
  }

  async function createExpenseFromTxn(txn) {
    setBusyId(txn.id)
    const expenseRef = await addDoc(collection(db, 'expenses'), {
      userId: auth.currentUser.uid,
      userEmail: auth.currentUser.email,
      projectId: activeProject.id,
      date: txn.transactionDate || '',
      vendor: txn.merchantNormalized ? txn.merchantNormalized.replace(/\b\w/g, c => c.toUpperCase()) : txn.merchantRaw,
      amount: txn.settlementAmount,
      currency: txn.settlementCurrency,
      category: 'Other',
      notes: `Created from ${accountLabel(txn.paymentAccountId)} statement — receipt pending`,
      paymentMethod: '',
      images: [],
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
    await addDoc(collection(db, 'reconciliationActions'), {
      userId: auth.currentUser.uid,
      projectId: activeProject.id,
      paymentTransactionId: txn.id,
      expenseId: expenseRef.id,
      actionType: 'expense_created',
      beforeState: null,
      afterState: { expenseId: expenseRef.id },
      createdAt: serverTimestamp(),
      actor: { uid: auth.currentUser.uid, email: auth.currentUser.email },
    })
    setBusyId(null)
  }

  async function linkSettlement(card, bankTxn) {
    setBusyId(card.id)
    const groupId = doc(collection(db, 'reconciliationActions')).id
    await updateDoc(doc(db, 'paymentTransactions', card.id), { settlementGroupId: groupId, status: 'matched', updatedAt: serverTimestamp() })
    await updateDoc(doc(db, 'paymentTransactions', bankTxn.id), { settlementGroupId: groupId, status: 'matched', updatedAt: serverTimestamp() })
    await addDoc(collection(db, 'reconciliationActions'), {
      userId: auth.currentUser.uid,
      projectId: activeProject.id,
      paymentTransactionId: card.id,
      expenseId: null,
      actionType: 'settlement_linked',
      beforeState: null,
      afterState: { settlementGroupId: groupId, linkedTransactionId: bankTxn.id },
      createdAt: serverTimestamp(),
      actor: { uid: auth.currentUser.uid, email: auth.currentUser.email },
    })
    setBusyId(null)
  }

  const suggested = transactions.filter(t => t.status === 'suggested')
  const autoSuggested = suggested.filter(t => (t.confidenceScore || 0) >= 90)
  const needsReview = suggested.filter(t => (t.confidenceScore || 0) < 90)
  const ignored = transactions.filter(t => t.status === 'ignored')

  const listForTab = {
    'Auto-suggested': autoSuggested,
    'Needs Review': needsReview,
    'Card Settlements': null, // rendered separately below
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
            {t === 'Auto-suggested' && ` (${autoSuggested.length})`}
            {t === 'Needs Review' && ` (${needsReview.length})`}
            {t === 'Card Settlements' && ` (${settlementCandidates.length})`}
            {t === 'Ignored' && ` (${ignored.length})`}
          </button>
        ))}
      </div>

      {tab === 'Card Settlements' ? (
        settlementCandidates.length === 0
          ? <p className="empty">No card-payment-to-bank-debit candidates found. Run Matching after importing both a credit card and bank statement.</p>
          : settlementCandidates.map(({ card, bankTxn, score, reasons }) => (
              <div key={card.id} className="card">
                <div className="card-header"><h3>Possible Card Settlement</h3><span className="badge badge-office">{score} pts</span></div>
                <p><strong>Card payment:</strong> {card.merchantRaw} — {card.settlementCurrency} {card.settlementAmount.toFixed(2)} on {card.transactionDate} ({accountLabel(card.paymentAccountId)})</p>
                <p><strong>Bank debit:</strong> {bankTxn.merchantRaw} — {bankTxn.settlementCurrency} {bankTxn.settlementAmount.toFixed(2)} on {bankTxn.transactionDate} ({accountLabel(bankTxn.paymentAccountId)})</p>
                <p className="hint">{reasons.join(' · ')}</p>
                <div className="action-row" style={{ marginTop: 12 }}>
                  <button className="btn-primary" disabled={busyId === card.id} onClick={() => linkSettlement(card, bankTxn)}>Link Settlement</button>
                  <button className="btn-ghost" disabled={busyId === card.id} onClick={() => ignoreTxn(card)}>Not Related</button>
                </div>
              </div>
            ))
      ) : listForTab.length === 0 ? (
        <p className="empty">Nothing here.</p>
      ) : (
        listForTab.map(txn => {
          const expense = txn.matchedExpenseIds?.[0] ? expenses.find(e => e.id === txn.matchedExpenseIds[0]) : null
          return (
            <div key={txn.id} className="card">
              <div className="card-header">
                <h3>{txn.merchantRaw || '(no description)'}</h3>
                {txn.confidenceScore != null && <span className="badge badge-office">{txn.confidenceScore} pts</span>}
              </div>
              <p>{accountLabel(txn.paymentAccountId)} · {txn.transactionDate || txn.rawDateText} · {txn.settlementCurrency} {txn.settlementAmount.toFixed(2)} · {txn.transactionType}</p>
              {expense && (
                <p className="hint">
                  Candidate: {expense.date} · {expense.vendor} · {expense.currency} {parseFloat(expense.amount).toFixed(2)} · {expense.category}
                </p>
              )}
              {txn.matchReasons?.length > 0 && <p className="hint">{txn.matchReasons.join(' · ')}</p>}
              {tab !== 'Ignored' && (
                <div className="action-row" style={{ marginTop: 12 }}>
                  {expense && <button className="btn-primary" disabled={busyId === txn.id} onClick={() => confirmMatch(txn)}>Confirm Match</button>}
                  <button className="btn-ghost" disabled={busyId === txn.id} onClick={() => createExpenseFromTxn(txn)}>Create Expense</button>
                  <button className="btn-ghost" disabled={busyId === txn.id} onClick={() => ignoreTxn(txn)}>Ignore</button>
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
