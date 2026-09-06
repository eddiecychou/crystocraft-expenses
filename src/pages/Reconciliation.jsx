import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { collection, query, where, onSnapshot, doc, updateDoc, addDoc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import { scoreExpenseMatch, scoreInvoiceMatch, scoreSettlementMatch, classifyReviewCategory, CREATE_EXPENSE_BLOCKED_TYPES, merchantSimilarity } from '../lib/paymentMatching'
import { DUPLICATE_STATUS_LABELS } from '../lib/duplicateDetection'
import { paymentTransactionsQuery } from '../lib/projectAccess'
import { BackIcon, ICON_STROKE_WIDTH } from '../icons'

const TOP_TABS = ['Needs Action', 'All', 'Matched', 'Exceptions']

const REVIEW_CATEGORY_LABELS = {
  possible_expense: 'Possible Expense',
  possible_income: 'Possible Income',
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

// Only ever shows one image at a time, but falls through the Expense's full
// image list on a load error instead of getting stuck on a broken icon —
// an Expense with 2+ attached images previously always rendered images[0]
// with no fallback, so a single bad/deleted Storage reference at that index
// left a permanently broken thumbnail even when a later image was fine.
function ReceiptThumb({ images }) {
  const [index, setIndex] = useState(0)
  const img = images?.[index]
  if (!img) return null
  if (img.name?.toLowerCase().endsWith('.pdf')) {
    return <p><a href={img.url} target="_blank" rel="noreferrer">View receipt (PDF)</a></p>
  }
  return (
    <img
      src={img.url}
      alt="Receipt"
      className="recon-receipt-thumb"
      onError={() => setIndex(i => i + 1)}
    />
  )
}

export default function Reconciliation() {
  const { activeProject } = useProject()
  const [transactions, setTransactions] = useState([])
  const [expenses, setExpenses] = useState([])
  const [invoices, setInvoices] = useState([])
  const [purchaseOrders, setPurchaseOrders] = useState([])
  const [accounts, setAccounts] = useState([])
  const [topTab, setTopTab] = useState('Needs Action')
  const [exceptionFilter, setExceptionFilter] = useState('all')
  const [sourceTypeFilter, setSourceTypeFilter] = useState('all')
  const [searchText, setSearchText] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [matching, setMatching] = useState(false)
  const [matchProgress, setMatchProgress] = useState({ done: 0, total: 0 })
  const [busyId, setBusyId] = useState(null)
  const [chosenExpenseId, setChosenExpenseId] = useState('')
  const [expenseSearchText, setExpenseSearchText] = useState('')
  const [chosenInvoiceId, setChosenInvoiceId] = useState('')
  const [invoiceSearchText, setInvoiceSearchText] = useState('')
  const [pickingPo, setPickingPo] = useState(false)
  const [poSearchText, setPoSearchText] = useState('')
  const [pickingSettlement, setPickingSettlement] = useState(false)
  const [chosenCounterpart, setChosenCounterpart] = useState('')

  useEffect(() => {
    if (!activeProject) return
    const uid = auth.currentUser.uid
    const unsubT = onSnapshot(
      paymentTransactionsQuery(query(collection(db, 'paymentTransactions'), where('projectId', '==', activeProject.id)), activeProject, uid),
      snap => setTransactions(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubE = onSnapshot(
      query(collection(db, 'expenses'), where('projectId', '==', activeProject.id)),
      snap => setExpenses(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubA = onSnapshot(
      query(collection(db, 'paymentAccounts'), where('projectId', '==', activeProject.id)),
      snap => setAccounts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubI = onSnapshot(
      query(collection(db, 'salesInvoices'), where('projectId', '==', activeProject.id)),
      snap => setInvoices(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubP = onSnapshot(
      query(collection(db, 'purchaseOrders'), where('projectId', '==', activeProject.id)),
      snap => setPurchaseOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    return () => { unsubT(); unsubE(); unsubA(); unsubI(); unsubP() }
  }, [activeProject?.id])

  // Reset the detail selection whenever the visible list changes shape, so
  // a stale selection from a different tab/filter can't linger unseen.
  useEffect(() => { setSelectedId(null); setChosenExpenseId(''); setExpenseSearchText(''); setChosenInvoiceId(''); setInvoiceSearchText(''); setPickingSettlement(false); setPickingPo(false) }, [topTab, exceptionFilter, sourceTypeFilter, searchText])
  // Switching to a different transaction should never carry over a manual
  // search/selection from whichever one was open before.
  useEffect(() => { setChosenExpenseId(''); setExpenseSearchText(''); setChosenInvoiceId(''); setInvoiceSearchText(''); setPickingPo(false); setPoSearchText('') }, [selectedId])

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
    // Also re-checks existing 'suggested' rows, not just 'unmatched' ones —
    // a suggestion made under an older/looser scoring rule (e.g. before
    // scoreExpenseMatch started disqualifying large date gaps) would
    // otherwise sit there forever, since a transaction already at
    // 'suggested' is never looked at again by a normal run.
    const candidates = transactions.filter(t => t.status === 'unmatched' || t.status === 'suggested')
    setMatchProgress({ done: 0, total: candidates.length })

    // Credit transactions never compete with debit transactions for the
    // same match — expenses are debit-only (scoreExpenseMatch already
    // enforces this), invoices are credit-only (scoreInvoiceMatch). Split
    // once up front so the recurring-series pairing and per-candidate
    // scoring below run against the right counterpart collection for each
    // side. 'payment'-type credits (card-balance payments) belong to
    // settlement linking, not income — excluded here too.
    const debitCandidates = candidates.filter(t => t.direction !== 'credit')
    const creditCandidates = candidates.filter(t => t.direction === 'credit' && t.transactionType !== 'payment')

    // A recurring subscription's several charges (and their matching
    // Expense records) all score IDENTICALLY against each other — same
    // amount, same currency, same merchant — so nearest-absolute-date can
    // still pick the wrong cycle once several fall within range of each
    // other, especially when a bill's date is offset from its charge by a
    // consistent lag (e.g. billed at cycle-end for a charge that landed at
    // cycle-start — one user-reported case was matched to a cycle 78 days
    // away). The fix is ORDER, not proximity: group both sides by
    // (merchant, amount, currency) and, when a group has the SAME COUNT on
    // both sides (the strongest signal neither series has a gap), pair them
    // up in chronological order — 1st transaction with 1st expense, 2nd
    // with 2nd, etc. Groups with mismatched counts fall through to the
    // normal per-pair scoring below rather than risk misaligning a series
    // that has a genuine gap (a missing receipt for one cycle, say).
    // Group transactions by (merchant, amount, currency); for each group of
    // 2+, find expenses matching on amount+currency and a HIGH merchant
    // similarity (same threshold scoreExpenseMatch itself uses for its
    // "Merchant name matches closely" bonus — a transaction's merchant text
    // is rarely byte-identical to how the expense's vendor was entered,
    // e.g. "CSL MOBILE LIMITED 168 HONG KONG HK" vs. "CSL Mobile", so an
    // exact-string group key would silently never match real data).
    function groupSequentialMatches(txns, records, recordAmount, recordCurrency, recordName, recordDate, scoreFn) {
      const groupKey = t => `${t.merchantNormalized || t.merchantRaw || ''}|${Math.abs(t.settlementAmount || 0).toFixed(2)}|${t.settlementCurrency}`
      const groups = new Map()
      for (const t of txns) {
        const k = groupKey(t)
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(t)
      }
      const sequentialMatch = new Map() // txn.id -> { recordId, score, reasons }
      for (const group of groups.values()) {
        if (group.length < 2) continue
        const sample = group[0]
        const candidates = records.filter(r =>
          !r.matchedPaymentTransactionId &&
          Math.abs(recordAmount(r) - sample.settlementAmount) < 0.01 &&
          recordCurrency(r) === sample.settlementCurrency &&
          merchantSimilarity(sample.merchantRaw, recordName(r)) === 'high'
        )
        if (candidates.length !== group.length) continue
        const sortedTxns = [...group].sort((a, b) => (a.transactionDate || '').localeCompare(b.transactionDate || ''))
        const sortedRecords = [...candidates].sort((a, b) => (recordDate(a) || '').localeCompare(recordDate(b) || ''))
        for (let i = 0; i < sortedTxns.length; i++) {
          const result = scoreFn(sortedTxns[i], sortedRecords[i])
          if (result && result.score >= 50) sequentialMatch.set(sortedTxns[i].id, { recordId: sortedRecords[i].id, score: result.score, reasons: result.reasons })
        }
      }
      return sequentialMatch
    }

    // Same recurring-series pairing logic (see block comment above) applied
    // to both sides: debit transactions against expenses, credit
    // transactions against invoices.
    const sequentialExpenseMatch = groupSequentialMatches(
      debitCandidates, expenses,
      e => parseFloat(e.amount), e => e.currency, e => e.vendor, e => e.date,
      scoreExpenseMatch
    )
    const sequentialInvoiceMatch = groupSequentialMatches(
      creditCandidates, invoices,
      inv => parseFloat(inv.amount), inv => inv.currency, inv => inv.counterpartyName, inv => inv.date,
      scoreInvoiceMatch
    )

    for (let i = 0; i < candidates.length; i++) {
      const txn = candidates[i]
      const isCredit = txn.direction === 'credit' && txn.transactionType !== 'payment'
      const records = isCredit ? invoices : expenses
      const scoreFn = isCredit ? scoreInvoiceMatch : scoreExpenseMatch
      const sequentialMatch = isCredit ? sequentialInvoiceMatch : sequentialExpenseMatch
      const matchField = isCredit ? 'matchedInvoiceIds' : 'matchedExpenseIds'

      let best = sequentialMatch.get(txn.id) || null
      if (!best) {
        // A recurring same-merchant/same-amount charge (a monthly
        // subscription, say) scores IDENTICALLY against every month's
        // record when it didn't qualify for the sequential pairing above
        // (mismatched series counts) — the score alone can't tell June's
        // from August's. Without a tiebreaker, `>` picks whichever
        // candidate happens to come first in Firestore's arbitrary
        // document order, not the one actually closest in date.
        let bestDays = Infinity
        for (const rec of records) {
          const result = scoreFn(txn, rec)
          if (!result) continue
          const days = Math.abs(Date.parse(txn.transactionDate) - Date.parse(rec.date)) / 86400000
          const better = !best || result.score > best.score || (result.score === best.score && days < bestDays)
          if (better) { best = { ...result, recordId: rec.id }; bestDays = days }
        }
      }
      if (best && best.score >= 50) {
        const unchanged = txn.status === 'suggested' && txn[matchField]?.[0] === best.recordId && txn.confidenceScore === best.score
        if (!unchanged) {
          await updateDoc(doc(db, 'paymentTransactions', txn.id), {
            status: 'suggested',
            matchedExpenseIds: isCredit ? [] : [best.recordId],
            matchedInvoiceIds: isCredit ? [best.recordId] : [],
            confidenceScore: best.score,
            matchReasons: best.reasons,
            updatedAt: serverTimestamp(),
          })
        }
      } else if (txn.status === 'suggested') {
        // No longer a valid suggestion under current scoring (e.g. the
        // date-gap disqualifier) — revert it rather than leave a stale bad
        // match sitting there indefinitely.
        await updateDoc(doc(db, 'paymentTransactions', txn.id), {
          status: 'unmatched',
          matchedExpenseIds: [],
          matchedInvoiceIds: [],
          confidenceScore: null,
          matchReasons: [],
          updatedAt: serverTimestamp(),
        })
      }
      setMatchProgress({ done: i + 1, total: candidates.length })
      // Only transactions that actually score high enough above ever hit an
      // `await` — with thousands of candidates that mostly DON'T match
      // anything, the loop could otherwise run for a long stretch with no
      // `await` at all, freezing the tab solid with zero visible progress
      // (looks exactly like the button doing nothing). Yielding periodically
      // keeps the browser painting the progress bar/counter and responsive.
      if (i % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
    setMatching(false)
  }

  // Settlement candidates (card `payment` row -> bank `debit` row) are cheap
  // to compute live from what's already loaded — no need to persist a
  // suggestion until the user actually confirms the link.
  const settlementCandidates = useMemo(() => {
    const cardPayments = transactions.filter(t => t.transactionType === 'payment' && !t.settlementGroupId && t.status !== 'ignored' && t.status !== 'matched')
    const bankDebits = transactions.filter(t => t.direction === 'debit' && t.transactionType !== 'payment' && !t.settlementGroupId && t.status !== 'ignored' && t.status !== 'matched')
    const out = []
    for (const card of cardPayments) {
      // Same tiebreaker as the expense-match loop above — a recurring
      // card-payment amount can tie in score against several bank debits.
      let best = null
      let bestDays = Infinity
      for (const bank of bankDebits) {
        const result = scoreSettlementMatch(card, bank)
        if (!result) continue
        const days = Math.abs(Date.parse(card.transactionDate) - Date.parse(bank.transactionDate)) / 86400000
        const better = !best || result.score > best.score || (result.score === best.score && days < bestDays)
        if (better) { best = { ...result, bankTxn: bank }; bestDays = days }
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

  // Same account + amount + merchant, seen within a few days of another
  // still-active row, is a real signal of a possible duplicate. Previously
  // this grouped by the stored fingerprintLoose, which buckets by calendar
  // month — two legitimate monthly charges landing in the same month (e.g.
  // the 3rd and the 30th, 27 days apart, from a billing-date drift) shared
  // a bucket and got flagged "Possible Duplicate" every month even though
  // they're obviously separate charges. A tight day-window computed fresh
  // from the actual dates catches genuine accidental re-imports/double
  // charges without mislabeling routine recurring subscriptions.
  const DUPLICATE_WINDOW_DAYS = 3
  const riskyDuplicateIds = useMemo(() => {
    const groups = new Map()
    for (const t of transactions) {
      if (t.status === 'ignored' || t.status === 'matched') continue
      const key = [t.paymentAccountId, Math.abs(t.settlementAmount || 0).toFixed(2), (t.merchantNormalized || '').split(' ')[0], t.settlementCurrency].join('|')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(t)
    }
    const risky = new Set()
    for (const group of groups.values()) {
      if (group.length < 2) continue
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = Date.parse(group[i].transactionDate)
          const b = Date.parse(group[j].transactionDate)
          if (Number.isNaN(a) || Number.isNaN(b)) continue
          if (Math.abs(a - b) / 86400000 <= DUPLICATE_WINDOW_DAYS) {
            risky.add(group[i].id)
            risky.add(group[j].id)
          }
        }
      }
    }
    return risky
  }, [transactions])

  function categoryFor(txn) {
    if (txn.status !== 'suggested') return null
    return classifyReviewCategory(txn, { hasDuplicate: riskyDuplicateIds.has(txn.id) })
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
    if (cat && cat !== 'possible_expense' && cat !== 'possible_income') return true
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
  }, [transactions, expenses, settlementCandidates, riskyDuplicateIds])

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
  }, [transactions, accounts, topTab, exceptionFilter, sourceTypeFilter, searchText, settlementCandidateByCardId, riskyDuplicateIds])

  const selected = filteredRows.find(t => t.id === selectedId) || null
  const selectedSettlement = selected ? settlementCandidateByCardId.get(selected.id) : null
  const selectedExpense = selected?.matchedExpenseIds?.[0] ? expenses.find(e => e.id === selected.matchedExpenseIds[0]) : null
  const selectedInvoice = selected?.matchedInvoiceIds?.[0] ? invoices.find(inv => inv.id === selected.matchedInvoiceIds[0]) : null
  const selectedPo = selected?.matchedPoId ? purchaseOrders.find(po => po.id === selected.matchedPoId) : null
  const selectedCategory = selected ? categoryFor(selected) : null

  // Resolving one item in the Needs Action queue used to leave the detail
  // panel showing the now-resolved transaction until the user manually went
  // back to the list and picked the next one — wasted a click per item on a
  // queue that can run into the hundreds. Jumps straight to whatever's next
  // in the currently-displayed order (list is already sorted Needs Action
  // first), falling back to no selection once the queue is actually empty.
  function selectNextNeedingAction(resolvedId) {
    const idx = filteredRows.findIndex(t => t.id === resolvedId)
    const next = filteredRows.slice(idx + 1).find(t => t.id !== resolvedId && needsAction(t))
    setSelectedId(next ? next.id : null)
  }

  // Lets an already-matched expense be freed up right from the search
  // results, instead of "found it, but can't use it" with no way to see
  // which transaction has it or undo that match without leaving this page
  // to go hunt for it on Records. Same both-sides revert as Expenses.jsx's
  // unlinkExpenseMatch — the transaction-side update is best-effort, since
  // that transaction may have been deleted independently since the match.
  async function unlinkExpense(e) {
    if (!confirm(`Unmatch "${e.vendor}" (${e.date}) from its current transaction so you can match it here instead?`)) return
    if (e.matchedPaymentTransactionId) {
      await updateDoc(doc(db, 'paymentTransactions', e.matchedPaymentTransactionId), {
        status: 'unmatched',
        matchedExpenseIds: [],
        confidenceScore: null,
        matchReasons: [],
        updatedAt: serverTimestamp(),
      }).catch(() => {})
    }
    await updateDoc(doc(db, 'expenses', e.id), {
      matchedPaymentTransactionId: null,
      matchedPaymentAccountId: null,
      settlementAmount: null,
      settlementCurrency: null,
      settlementStatus: 'unsettled',
    })
  }

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
    selectNextNeedingAction(txn.id)
  }

  // Mirrors unlinkExpense, for the income side.
  async function unlinkInvoice(inv) {
    if (!confirm(`Unmatch "${inv.counterpartyName}" (${inv.date}) from its current transaction so you can match it here instead?`)) return
    if (inv.matchedPaymentTransactionId) {
      await updateDoc(doc(db, 'paymentTransactions', inv.matchedPaymentTransactionId), {
        status: 'unmatched',
        matchedInvoiceIds: [],
        confidenceScore: null,
        matchReasons: [],
        updatedAt: serverTimestamp(),
      }).catch(() => {})
    }
    await updateDoc(doc(db, 'salesInvoices', inv.id), {
      matchedPaymentTransactionId: null,
      matchedPaymentAccountId: null,
      settlementStatus: 'unsettled',
    })
  }

  // Mirrors confirmMatch, for the income side: links a credit transaction
  // to a salesInvoices record instead of an expense.
  async function confirmInvoiceMatch(txn, invoiceIdOverride) {
    const invoiceId = invoiceIdOverride || txn.matchedInvoiceIds?.[0]
    if (!invoiceId) return
    const invoice = invoices.find(inv => inv.id === invoiceId)
    if (!invoice) return
    if (invoice.matchedPaymentTransactionId && invoice.matchedPaymentTransactionId !== txn.id) {
      alert('That invoice is already matched to a different transaction. Unmatch it first, or choose a different invoice.')
      return
    }
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      status: 'matched',
      matchedInvoiceIds: [invoiceId],
      updatedAt: serverTimestamp(),
    })
    await updateDoc(doc(db, 'salesInvoices', invoiceId), {
      matchedPaymentTransactionId: txn.id,
      matchedPaymentAccountId: txn.paymentAccountId,
      settlementStatus: 'confirmed',
    })
    await logAction(txn, invoiceId, 'invoice_matched', { status: txn.status }, { status: 'matched' })
    setBusyId(null)
    setChosenInvoiceId('')
    selectNextNeedingAction(txn.id)
  }

  // Manual-only PO linking (see LESSONS_LEARNED.md) — mutually exclusive
  // with expense-matching because both apply only to debit transactions,
  // and this always sets status:'matched', removing the transaction from
  // runMatching()'s candidate pool.
  async function linkPurchaseOrder(txn, poId) {
    const po = purchaseOrders.find(p => p.id === poId)
    if (!po) return
    if (po.matchedPaymentTransactionId && po.matchedPaymentTransactionId !== txn.id) {
      alert('That purchase order is already matched to a different transaction. Unmatch it first, or choose a different one.')
      return
    }
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      status: 'matched',
      matchedPoId: poId,
      updatedAt: serverTimestamp(),
    })
    await updateDoc(doc(db, 'purchaseOrders', poId), {
      matchedPaymentTransactionId: txn.id,
      matchedPaymentAccountId: txn.paymentAccountId,
      settlementStatus: 'confirmed',
    })
    await logAction(txn, null, 'po_linked', { status: txn.status }, { status: 'matched', poId })
    setBusyId(null)
    setPickingPo(false)
    setPoSearchText('')
    selectNextNeedingAction(txn.id)
  }

  // Mirrors unlinkExpense, for a PO linked from within the Records-style
  // search picker below.
  async function unlinkPurchaseOrder(po) {
    if (!confirm(`Unmatch "${po.counterpartyName}" (${po.date}) from its current transaction so you can match it here instead?`)) return
    if (po.matchedPaymentTransactionId) {
      await updateDoc(doc(db, 'paymentTransactions', po.matchedPaymentTransactionId), {
        status: 'unmatched',
        matchedPoId: null,
        updatedAt: serverTimestamp(),
      }).catch(() => {})
    }
    await updateDoc(doc(db, 'purchaseOrders', po.id), {
      matchedPaymentTransactionId: null,
      matchedPaymentAccountId: null,
      settlementStatus: 'unsettled',
    })
  }

  async function ignoreTxn(txn) {
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), { status: 'ignored', updatedAt: serverTimestamp() })
    await logAction(txn, null, 'ignored', { status: txn.status }, { status: 'ignored' })
    setBusyId(null)
    selectNextNeedingAction(txn.id)
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
    if (txn.matchedInvoiceIds?.[0]) {
      await updateDoc(doc(db, 'salesInvoices', txn.matchedInvoiceIds[0]), {
        matchedPaymentTransactionId: null,
        matchedPaymentAccountId: null,
        settlementStatus: 'unsettled',
      })
    }
    if (txn.matchedPoId) {
      await updateDoc(doc(db, 'purchaseOrders', txn.matchedPoId), {
        matchedPaymentTransactionId: null,
        matchedPaymentAccountId: null,
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
      matchedInvoiceIds: [],
      matchedPoId: null,
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
    selectNextNeedingAction(txn.id)
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
    selectNextNeedingAction(txn.id)
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
    selectNextNeedingAction(card.id)
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
    selectNextNeedingAction(txn.id)
  }

  function dismissDuplicateWarning(txn) {
    setBusyId(txn.id)
    updateDoc(doc(db, 'paymentTransactions', txn.id), {
      duplicateReviewedBy: auth.currentUser.email,
      duplicateReviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }).finally(() => { setBusyId(null); selectNextNeedingAction(txn.id) })
  }

  // Any active, unlinked transaction on a different account can be picked
  // as a manual settlement counterpart — not limited to the auto-detected
  // card-payment/bank-debit shape, since the user may be linking a case the
  // heuristic missed.
  const settlementCounterpartOptions = txn => transactions.filter(t =>
    t.id !== txn.id && !t.settlementGroupId && t.paymentAccountId !== txn.paymentAccountId &&
    ['unmatched', 'suggested'].includes(t.status)
  )

  if (!activeProject) return <div className="page page-wide"><p className="loading">Loading…</p></div>

  return (
    <div className="page page-wide">
      <ProjectBanner />
      <div className="card-header" style={{ marginBottom: matching ? 4 : 16 }}>
        <h2 style={{ marginBottom: 0 }}>Reconciliation</h2>
        <span className="action-row" style={{ margin: 0, alignItems: 'center' }}>
          {matching && <span className="hint">Matching {matchProgress.done} of {matchProgress.total}…</span>}
          <button className="btn-ghost" onClick={runMatching} disabled={matching}>
            {matching ? 'Matching…' : 'Run Matching'}
          </button>
        </span>
      </div>
      {matching && (
        <div className="scan-progress-bar" style={{ marginBottom: 16 }}><div className="scan-progress-fill" /></div>
      )}

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
        <div>
          <p className="empty">
            {transactions.length === 0
              ? 'No statement transactions imported yet.'
              : topTab === 'Needs Action' ? "Nothing needs action right now — you're caught up."
              : topTab === 'Matched' ? 'No matched transactions yet.'
              : topTab === 'Exceptions' ? 'No exceptions in this filter.'
              : 'Nothing matches the current filters.'}
          </p>
          {transactions.length === 0 && <Link to="/payment-sources" className="btn-primary">Import a Statement</Link>}
        </div>
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
                <button className="btn-ghost btn-small mobile-only" style={{ marginBottom: 12 }} onClick={() => setSelectedId(null)}>
                  <BackIcon size={14} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" /> Back to list
                </button>

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
                  <div className="meta-grid">
                    <div className="meta-field">
                      <div className="meta-field-label">Transaction date</div>
                      <div className="meta-field-value">{selected.transactionDate || selected.rawDateText || '—'}</div>
                    </div>
                    {selected.postDate && (
                      <div className="meta-field">
                        <div className="meta-field-label">Posting date</div>
                        <div className="meta-field-value">{selected.postDate}</div>
                      </div>
                    )}
                    <div className="meta-field">
                      <div className="meta-field-label">Direction</div>
                      <div className="meta-field-value">{selected.direction}</div>
                    </div>
                    {selected.balanceAfter != null && (
                      <div className="meta-field">
                        <div className="meta-field-label">Balance after</div>
                        <div className="meta-field-value">{selected.balanceAfter.toFixed(2)}</div>
                      </div>
                    )}
                    <div className="meta-field">
                      <div className="meta-field-label">Type</div>
                      <div className="meta-field-value">{selected.transactionType}</div>
                    </div>
                  </div>
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
                    {/* Date and amount are what actually has to match between
                        the two rows — bolded so the eye can jump straight to
                        the two values worth comparing instead of reading the
                        whole sentence, per feedback that this took too long
                        to eyeball across a long settlement queue. */}
                    <p><strong>Card payment:</strong> {selectedSettlement.card.merchantRaw} — <strong data-amount="true">{selectedSettlement.card.settlementCurrency} {selectedSettlement.card.settlementAmount.toFixed(2)}</strong> on <strong>{selectedSettlement.card.transactionDate}</strong> ({accountLabel(selectedSettlement.card.paymentAccountId)})</p>
                    <p><strong>Bank debit:</strong> {selectedSettlement.bankTxn.merchantRaw} — <strong data-amount="true">{selectedSettlement.bankTxn.settlementCurrency} {selectedSettlement.bankTxn.settlementAmount.toFixed(2)}</strong> on <strong>{selectedSettlement.bankTxn.transactionDate}</strong> ({accountLabel(selectedSettlement.bankTxn.paymentAccountId)})</p>
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
                        <ReceiptThumb key={selectedExpense.id} images={selectedExpense.images} />
                      </>
                    ) : selectedInvoice ? (
                      <p>Income invoice: {selectedInvoice.date} · {selectedInvoice.counterpartyName} · {selectedInvoice.number} · {selectedInvoice.currency} {Number(selectedInvoice.amount || 0).toFixed(2)}</p>
                    ) : selectedPo ? (
                      <p>Purchase order: {selectedPo.date} · {selectedPo.counterpartyName} · {selectedPo.number} · {selectedPo.currency} {Number(selectedPo.amount || 0).toFixed(2)}</p>
                    ) : selected.settlementGroupId ? (
                      <p className="hint">Linked as a credit-card settlement — not a business expense.</p>
                    ) : (
                      <p className="hint">Matched, but the linked record could not be found (it may have been deleted).</p>
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
                    {selectedCategory === 'possible_duplicate' && (
                      <p className="hint">
                        Another transaction with the same amount and merchant was recorded within a few days
                        of this one — worth a quick check that it isn't the same charge counted twice. This
                        doesn't affect the match below: if it's a genuine separate charge, just confirm
                        the match as normal.
                      </p>
                    )}
                    {selectedExpense && (
                      <>
                        <p>Suggested Expense: {selectedExpense.date} · {selectedExpense.vendor} · {selectedExpense.currency} {parseFloat(selectedExpense.amount).toFixed(2)} · {selectedExpense.category}</p>
                        <ReceiptThumb key={selectedExpense.id} images={selectedExpense.images} />
                      </>
                    )}
                    {selectedInvoice && (
                      <p>Suggested Invoice: {selectedInvoice.date} · {selectedInvoice.counterpartyName} · {selectedInvoice.number} · {selectedInvoice.currency} {Number(selectedInvoice.amount || 0).toFixed(2)}</p>
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
                      {selected.direction !== 'credit' && selectedExpense && !CREATE_EXPENSE_BLOCKED_TYPES.includes(selected.transactionType) && (
                        <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => createExpenseFromTxn(selected)}>
                          {busyId === selected.id ? 'Creating…' : 'Create Expense'}
                        </button>
                      )}
                      {selected.direction !== 'credit' && CREATE_EXPENSE_BLOCKED_TYPES.includes(selected.transactionType) && (
                        <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => {
                          if (confirm(`This transaction was classified as ${selected.transactionType}, which is not normally a business expense. Create an Expense from it anyway?`)) createExpenseFromTxn(selected, { force: true })
                        }}>
                          {busyId === selected.id ? 'Creating…' : 'Create Expense Anyway'}
                        </button>
                      )}
                      {selected.direction !== 'credit' && (
                        <button className="btn-ghost" disabled={busyId === selected.id} onClick={() => setPickingPo(true)}>Link to Purchase Order</button>
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

                    {/* A native <select> listing every unmatched expense
                        project-wide, unsorted, made manual matching mean
                        scrolling through dozens of unrelated vendors to find
                        one by eye. Type-to-search instead: filters by
                        vendor/amount/date as you type, results sorted by
                        date distance from the transaction being matched so
                        the likeliest candidates lead even with a broad
                        search term. */}
                    {selected.direction !== 'credit' && (
                    <div className="expense-search" style={{ marginTop: 10 }}>
                      <input
                        type="text"
                        placeholder="Type a vendor name, amount, or date to find the matching expense…"
                        value={expenseSearchText}
                        onChange={e => { setExpenseSearchText(e.target.value); setChosenExpenseId('') }}
                      />
                      {expenseSearchText.trim() && (() => {
                        const q = expenseSearchText.trim().toLowerCase()
                        // Was completely capped at 8 (the results box
                        // already scrolls, so no reason to truncate), and
                        // an already-matched expense was silently excluded
                        // entirely — "found it, but can't use it, and no
                        // way to see which transaction has it or free it
                        // up" without leaving this page to go hunt for it
                        // on Records. Both fixed: no cap, and an
                        // already-matched result stays visible with its own
                        // Unmatch action right here.
                        const results = expenses
                          .filter(e => [e.vendor, e.date, e.currency, Number(e.amount || 0).toFixed(2)].join(' ').toLowerCase().includes(q))
                          .sort((a, b) => {
                            const da = Math.abs(Date.parse(a.date) - Date.parse(selected.transactionDate))
                            const db = Math.abs(Date.parse(b.date) - Date.parse(selected.transactionDate))
                            return (Number.isNaN(da) ? Infinity : da) - (Number.isNaN(db) ? Infinity : db)
                          })
                        return (
                          <div className="expense-search-results">
                            {results.length === 0 && <p className="hint">No matching expenses.</p>}
                            {results.map(e => {
                              // Compares against the TRANSACTION's own id
                              // (matching exactly what confirmMatch itself
                              // checks), not against selectedExpense — that
                              // was a live bug: selectedExpense comes from
                              // this transaction's own (possibly wrong,
                              // merely-suggested, never-confirmed) matchedExpenseIds
                              // link, which can point at an expense whose
                              // REAL matchedPaymentTransactionId is actually
                              // some other, already-confirmed transaction.
                              // Comparing e.id to that suggestion silently
                              // hid the real conflict — the expense showed
                              // as selectable, then failed at Confirm.
                              const linkedElsewhere = e.matchedPaymentTransactionId && e.matchedPaymentTransactionId !== selected.id
                              return linkedElsewhere ? (
                                <div key={e.id} className="expense-search-result expense-search-result-linked">
                                  <span>{e.date} · {e.vendor} · {e.currency} {Number(e.amount || 0).toFixed(2)} <span className="hint">— matched elsewhere</span></span>
                                  <button type="button" className="btn-small btn-ghost" onClick={() => unlinkExpense(e)}>Unmatch</button>
                                </div>
                              ) : (
                                <button
                                  key={e.id}
                                  type="button"
                                  className={`expense-search-result${chosenExpenseId === e.id ? ' is-selected' : ''}`}
                                  onClick={() => setChosenExpenseId(e.id)}
                                >
                                  {e.date} · {e.vendor} · {e.currency} {Number(e.amount || 0).toFixed(2)}
                                </button>
                              )
                            })}
                          </div>
                        )
                      })()}
                      <button className="btn-small" style={{ marginTop: 8 }} disabled={busyId === selected.id || !chosenExpenseId} onClick={() => confirmMatch(selected, chosenExpenseId)}>Confirm Chosen Expense</button>
                    </div>
                    )}

                    {/* Income side: same type-to-search pattern as the
                        expense picker above, but over salesInvoices,
                        matching by customer name/number/amount/date. */}
                    {selected.direction === 'credit' && (
                    <div className="expense-search" style={{ marginTop: 10 }}>
                      <input
                        type="text"
                        placeholder="Type a customer name, invoice #, amount, or date to find the matching invoice…"
                        value={invoiceSearchText}
                        onChange={e => { setInvoiceSearchText(e.target.value); setChosenInvoiceId('') }}
                      />
                      {invoiceSearchText.trim() && (() => {
                        const q = invoiceSearchText.trim().toLowerCase()
                        const results = invoices
                          .filter(inv => [inv.counterpartyName, inv.number, inv.date, inv.currency, Number(inv.amount || 0).toFixed(2)].join(' ').toLowerCase().includes(q))
                          .sort((a, b) => {
                            const da = Math.abs(Date.parse(a.date) - Date.parse(selected.transactionDate))
                            const db = Math.abs(Date.parse(b.date) - Date.parse(selected.transactionDate))
                            return (Number.isNaN(da) ? Infinity : da) - (Number.isNaN(db) ? Infinity : db)
                          })
                        return (
                          <div className="expense-search-results">
                            {results.length === 0 && <p className="hint">No matching invoices.</p>}
                            {results.map(inv => {
                              const linkedElsewhere = inv.matchedPaymentTransactionId && inv.matchedPaymentTransactionId !== selected.id
                              return linkedElsewhere ? (
                                <div key={inv.id} className="expense-search-result expense-search-result-linked">
                                  <span>{inv.date} · {inv.counterpartyName} · {inv.number} · {inv.currency} {Number(inv.amount || 0).toFixed(2)} <span className="hint">— matched elsewhere</span></span>
                                  <button type="button" className="btn-small btn-ghost" onClick={() => unlinkInvoice(inv)}>Unmatch</button>
                                </div>
                              ) : (
                                <button
                                  key={inv.id}
                                  type="button"
                                  className={`expense-search-result${chosenInvoiceId === inv.id ? ' is-selected' : ''}`}
                                  onClick={() => setChosenInvoiceId(inv.id)}
                                >
                                  {inv.date} · {inv.counterpartyName} · {inv.number} · {inv.currency} {Number(inv.amount || 0).toFixed(2)}
                                </button>
                              )
                            })}
                          </div>
                        )
                      })()}
                      <button className="btn-small" style={{ marginTop: 8 }} disabled={busyId === selected.id || !chosenInvoiceId} onClick={() => confirmInvoiceMatch(selected, chosenInvoiceId)}>Confirm Chosen Invoice</button>
                    </div>
                    )}

                    {/* Manual PO linking (debit only) — deliberately not
                        auto-suggested, see LESSONS_LEARNED.md: keeps this
                        mutually exclusive with expense-matching without a
                        two-scorer tiebreak. */}
                    {selected.direction !== 'credit' && pickingPo && (() => {
                      const q = poSearchText.trim().toLowerCase()
                      const results = purchaseOrders
                        .filter(po => !q || [po.counterpartyName, po.number, po.date, po.currency, Number(po.amount || 0).toFixed(2)].join(' ').toLowerCase().includes(q))
                        .sort((a, b) => {
                          const da = Math.abs(Date.parse(a.date) - Date.parse(selected.transactionDate))
                          const db = Math.abs(Date.parse(b.date) - Date.parse(selected.transactionDate))
                          return (Number.isNaN(da) ? Infinity : da) - (Number.isNaN(db) ? Infinity : db)
                        })
                      return (
                        <div className="expense-search" style={{ marginTop: 10 }}>
                          <input
                            type="text"
                            placeholder="Type a supplier name, PO #, amount, or date to find the matching purchase order…"
                            value={poSearchText}
                            onChange={e => setPoSearchText(e.target.value)}
                          />
                          <div className="expense-search-results">
                            {results.length === 0 && <p className="hint">No matching purchase orders.</p>}
                            {results.map(po => {
                              const linkedElsewhere = po.matchedPaymentTransactionId && po.matchedPaymentTransactionId !== selected.id
                              return linkedElsewhere ? (
                                <div key={po.id} className="expense-search-result expense-search-result-linked">
                                  <span>{po.date} · {po.counterpartyName} · {po.number} · {po.currency} {Number(po.amount || 0).toFixed(2)} <span className="hint">— matched elsewhere</span></span>
                                  <button type="button" className="btn-small btn-ghost" onClick={() => unlinkPurchaseOrder(po)}>Unmatch</button>
                                </div>
                              ) : (
                                <button key={po.id} type="button" className="expense-search-result" onClick={() => linkPurchaseOrder(selected, po.id)}>
                                  {po.date} · {po.counterpartyName} · {po.number} · {po.currency} {Number(po.amount || 0).toFixed(2)}
                                </button>
                              )
                            })}
                          </div>
                          <button className="btn-small btn-ghost" style={{ marginTop: 8 }} onClick={() => { setPickingPo(false); setPoSearchText('') }}>Cancel</button>
                        </div>
                      )
                    })()}

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
                      {selectedInvoice ? (
                        <button className="btn-primary" disabled={busyId === selected.id} onClick={() => confirmInvoiceMatch(selected)}>
                          {busyId === selected.id ? 'Confirming…' : 'Confirm Match'}
                        </button>
                      ) : selectedExpense ? (
                        <button className="btn-primary" disabled={busyId === selected.id} onClick={() => confirmMatch(selected)}>
                          {busyId === selected.id ? 'Confirming…' : 'Confirm Match'}
                        </button>
                      ) : selected.direction === 'credit' ? (
                        <button className="btn-primary" disabled={busyId === selected.id} onClick={() => ignoreTxn(selected)}>
                          {busyId === selected.id ? 'Ignoring…' : 'Ignore'}
                        </button>
                      ) : !CREATE_EXPENSE_BLOCKED_TYPES.includes(selected.transactionType) ? (
                        <button className="btn-primary" disabled={busyId === selected.id} onClick={() => createExpenseFromTxn(selected)}>
                          {busyId === selected.id ? 'Creating…' : 'Create Expense'}
                        </button>
                      ) : (
                        <button className="btn-primary" disabled={busyId === selected.id} onClick={() => ignoreTxn(selected)}>
                          {busyId === selected.id ? 'Ignoring…' : 'Ignore'}
                        </button>
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
