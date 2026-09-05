import { useState, useEffect } from 'react'
import { collection, query, where, onSnapshot, doc, setDoc, deleteDoc, updateDoc, addDoc, writeBatch, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import ConfirmDialog from '../components/ConfirmDialog'
import { CLASSIFICATION_LABELS, BUSINESS_PURPOSE_OPTIONS, merchantRuleDocId } from '../lib/expenseClassification'
import { CREATE_EXPENSE_BLOCKED_TYPES } from '../lib/paymentMatching'

const CLASSIFICATION_BADGE_CLASS = {
  personal: 'badge-other',
  company_candidate: 'badge-office',
  company_confirmed: 'badge-success',
  shared: 'badge-warning',
  needs_accountant_review: 'badge-info',
  rejected_company_claim: 'badge-danger',
}

// Firestore 'in' queries cap at 10 values — chunk personal account ids so
// this still works once someone has more than 10 personal accounts, rather
// than silently dropping transactions past the 10th.
function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export default function CompanyReview() {
  const { activeProject } = useProject()
  const [accounts, setAccounts] = useState([])
  const [transactions, setTransactions] = useState([])
  const [rules, setRules] = useState([])
  const [expandedMerchant, setExpandedMerchant] = useState(null)
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [purposeDraft, setPurposeDraft] = useState({}) // { [txnId]: { option, note } }

  useEffect(() => {
    if (!activeProject) return
    const unsub = onSnapshot(
      query(collection(db, 'paymentAccounts'), where('userId', '==', auth.currentUser.uid), where('projectId', '==', activeProject.id)),
      snap => setAccounts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    return unsub
  }, [activeProject?.id])

  useEffect(() => {
    if (!activeProject) return
    const unsub = onSnapshot(
      query(collection(db, 'merchantRules'), where('userId', '==', auth.currentUser.uid), where('projectId', '==', activeProject.id)),
      snap => setRules(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.merchantKey || '').localeCompare(b.merchantKey || '')))
    )
    return unsub
  }, [activeProject?.id])

  const personalAccountIds = accounts.filter(a => a.ownershipType === 'personal').map(a => a.id)

  // Re-subscribes per chunk of personal account ids and merges results —
  // only classified rows (personal accounts) ever carry a `classification`
  // field, so company-account transactions never appear here at all.
  useEffect(() => {
    if (personalAccountIds.length === 0) { setTransactions([]); return }
    const chunks = chunk(personalAccountIds, 10)
    const byChunk = new Array(chunks.length).fill([])
    const unsubs = chunks.map((ids, i) => onSnapshot(
      query(collection(db, 'paymentTransactions'), where('userId', '==', auth.currentUser.uid), where('paymentAccountId', 'in', ids)),
      snap => {
        byChunk[i] = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        setTransactions(byChunk.flat())
      }
    ))
    return () => unsubs.forEach(u => u())
  }, [personalAccountIds.join(',')])

  const classified = transactions.filter(t => t.classification)

  const summary = {
    company_candidate: classified.filter(t => t.classification === 'company_candidate').length,
    personal: classified.filter(t => t.classification === 'personal').length,
    needs_accountant_review: classified.filter(t => t.classification === 'needs_accountant_review').length,
    missing_receipt: classified.filter(t => t.classification === 'company_candidate' && t.status !== 'matched').length,
  }

  const groups = Object.values(
    classified.reduce((acc, t) => {
      const key = t.merchantNormalized || t.merchantRaw || '(unknown)'
      if (!acc[key]) acc[key] = { key, merchant: t.merchantRaw, txns: [] }
      acc[key].txns.push(t)
      return acc
    }, {})
  ).sort((a, b) => b.txns.length - a.txns.length)

  function accountOf(id) { return accounts.find(a => a.id === id) }

  async function applyClassificationToGroup(group, classification, { saveRule = false } = {}) {
    const ids = group.txns.map(t => t.id)
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db)
      ids.slice(i, i + 400).forEach(id => batch.update(doc(db, 'paymentTransactions', id), {
        classification,
        classificationSource: 'user',
        suggestedClassification: null,
        updatedAt: serverTimestamp(),
      }))
      await batch.commit()
    }
    if (saveRule) {
      const merchantKey = group.txns[0]?.merchantNormalized
      if (merchantKey) {
        // Upserts one rule per (project, merchant) — re-confirming the same
        // merchant later updates the existing rule rather than piling up
        // duplicates. Saved as a SUGGESTION only (autoApprove: false) — per
        // spec §7, future imports never auto-classify from this merchant
        // until the user explicitly turns Auto-Approve on below.
        await setDoc(doc(db, 'merchantRules', merchantRuleDocId(activeProject.id, merchantKey)), {
          userId: auth.currentUser.uid,
          projectId: activeProject.id,
          merchantKey,
          merchantLabel: group.merchant,
          classification,
          confidence: 0.95,
          autoApprove: false,
          source: 'user_confirmed',
          lastConfirmedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
        }, { merge: true })
      }
    }
    setConfirmDialog(null)
  }

  function confirmGroupAction(group, classification, label) {
    const total = group.txns.reduce((s, t) => s + (t.settlementAmount || 0), 0)
    const summary = (
      <>
        You are about to update {group.txns.length} transaction{group.txns.length === 1 ? '' : 's'}:<br />
        Merchant: {group.merchant}<br />
        Classification: {label}<br />
        Estimated total: {group.txns[0]?.settlementCurrency || ''} {total.toFixed(2)}
      </>
    )
    setConfirmDialog({
      message: summary,
      confirmLabel: `Apply to These Only`,
      confirmClassName: 'btn-primary',
      onConfirm: () => applyClassificationToGroup(group, classification),
      // Per spec §7: saving a rule is a separate, explicit choice — never
      // the default action — so future transactions from this merchant are
      // suggested (not auto-classified) until Auto-Approve is turned on.
      extraLabel: `Apply + Suggest Rule for "${group.merchant}"`,
      extraClassName: 'btn-ghost',
      onExtra: () => applyClassificationToGroup(group, classification, { saveRule: true }),
    })
  }

  async function sendGroupToAccountant(group) {
    const candidates = group.txns.filter(t => t.classification === 'company_candidate' || t.classification === 'shared')
    if (candidates.length === 0) return
    const total = candidates.reduce((s, t) => s + (t.settlementAmount || 0), 0)
    setConfirmDialog({
      message: (
        <>
          Send {candidates.length} transaction{candidates.length === 1 ? '' : 's'} for Merchant: {group.merchant} to Accountant Review?<br />
          Estimated total: {candidates[0]?.settlementCurrency || ''} {total.toFixed(2)}
        </>
      ),
      confirmLabel: `Send ${candidates.length} to Accountant Review`,
      confirmClassName: 'btn-primary',
      onConfirm: async () => {
        for (let i = 0; i < candidates.length; i += 400) {
          const batch = writeBatch(db)
          candidates.slice(i, i + 400).forEach(t => batch.update(doc(db, 'paymentTransactions', t.id), {
            accountantStatus: 'pending',
            updatedAt: serverTimestamp(),
          }))
          await batch.commit()
        }
        setConfirmDialog(null)
      },
    })
  }

  async function setTxnClassification(txn, classification) {
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      classification,
      classificationSource: 'user',
      updatedAt: serverTimestamp(),
    })
    setBusyId(null)
  }

  async function saveBusinessPurpose(txn) {
    const draft = purposeDraft[txn.id] || {}
    const value = [draft.option, draft.note].filter(Boolean).join(' — ') || null
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), { businessPurpose: value, updatedAt: serverTimestamp() })
    setBusyId(null)
  }

  // Mirrors Reconciliation.jsx's createExpenseFromTxn — same shape, plus
  // this workflow's classification/business-purpose fields so the new
  // Expense carries the evidence already gathered here.
  async function createExpenseFromTxn(txn) {
    if (CREATE_EXPENSE_BLOCKED_TYPES.includes(txn.transactionType)) return
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
      notes: `Statement description: "${txn.merchantRaw}". Created from personal statement — receipt missing.${txn.businessPurpose ? ` Business purpose: ${txn.businessPurpose}.` : ''}`,
      paymentMethod: '',
      images: [],
      receiptStatus: 'missing',
      reconciliationStatus: 'created_from_statement',
      source: 'personal_statement',
      sourceTransactionId: txn.id,
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
      accountantStatus: 'pending',
      updatedAt: serverTimestamp(),
    })
    setBusyId(null)
  }

  async function toggleRuleAutoApprove(rule) {
    await updateDoc(doc(db, 'merchantRules', rule.id), { autoApprove: !rule.autoApprove, updatedAt: serverTimestamp() })
  }

  async function deleteRule(rule) {
    setConfirmDialog({
      message: <>Delete the rule for <strong>{rule.merchantLabel || rule.merchantKey}</strong>? Its transactions keep their current classification — only future imports stop using this rule.</>,
      confirmLabel: 'Delete Rule',
      confirmClassName: 'btn-danger',
      onConfirm: async () => { await deleteDoc(doc(db, 'merchantRules', rule.id)); setConfirmDialog(null) },
    })
  }

  if (!activeProject) return <div className="page page-standard"><p className="loading">Loading…</p></div>

  return (
    <div className="page page-standard">
      <ProjectBanner />
      <h2>Company Review</h2>
      <p className="hint">
        Transactions on personal accounts marked as mixing personal and company spending. The app only suggests
        classification and gathers evidence — the accountant/bookkeeper makes the final claim decision.
      </p>

      {personalAccountIds.length === 0 ? (
        <p className="empty">No personal accounts yet. Mark an account as personal in Payment Sources to start reviewing its transactions here.</p>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat-card"><div className="stat-label">Company Candidates</div><div className="stat-value">{summary.company_candidate}</div></div>
            <div className="stat-card"><div className="stat-label">Personal</div><div className="stat-value">{summary.personal}</div></div>
            <div className="stat-card"><div className="stat-label">Needs Review</div><div className="stat-value">{summary.needs_accountant_review}</div></div>
            <div className="stat-card"><div className="stat-label">Missing Receipt</div><div className="stat-value">{summary.missing_receipt}</div></div>
          </div>

          {rules.length > 0 && (
            <div className="card">
              <h3>Merchant Rules</h3>
              <p className="hint">
                Built from "Apply + Suggest Rule" below. A rule only suggests a classification unless
                Auto-Approve is turned on for that merchant — turning it on means future imports from
                this merchant classify automatically.
              </p>
              {rules.map(rule => (
                <div key={rule.id} className="category-row">
                  <span>
                    <strong>{rule.merchantLabel || rule.merchantKey}</strong>
                    <span className="hint"> → {CLASSIFICATION_LABELS[rule.classification] || rule.classification}</span>
                  </span>
                  <span className="action-row" style={{ margin: 0 }}>
                    <button className={`btn-small${rule.autoApprove ? ' btn-primary' : ' btn-ghost'}`} onClick={() => toggleRuleAutoApprove(rule)}>
                      {rule.autoApprove ? 'Auto-Approve: On' : 'Auto-Approve: Off'}
                    </button>
                    <button className="btn-small btn-danger" onClick={() => deleteRule(rule)}>Delete</button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <h3>Grouped by Merchant</h3>
            {groups.length === 0 && <p className="empty">No transactions yet — import a statement for a personal account in Payment Sources.</p>}

            {groups.map(group => {
              const total = group.txns.reduce((s, t) => s + (t.settlementAmount || 0), 0)
              const suggested = group.txns[0]?.classification
              const currency = group.txns[0]?.settlementCurrency || ''
              const expanded = expandedMerchant === group.key
              // A rule suggestion only ever shows up as metadata alongside
              // the existing classification — applying it still goes
              // through the same count+total confirm flow as any other
              // bulk action, never a silent auto-apply.
              const ruleSuggestion = group.txns.find(t => t.suggestedClassification)?.suggestedClassification

              return (
                <div key={group.key} className="company-review-group">
                  <div className="company-review-group-header">
                    <div>
                      <span className="mob-card-vendor">{group.merchant}</span>
                      <span className="hint"> · {group.txns.length} transaction{group.txns.length === 1 ? '' : 's'} · {currency} {total.toFixed(2)}</span>
                    </div>
                    <span className={`badge ${CLASSIFICATION_BADGE_CLASS[suggested] || 'badge-other'}`}>{CLASSIFICATION_LABELS[suggested] || suggested}</span>
                  </div>
                  {ruleSuggestion && (
                    <p className="hint">
                      Rule suggests <strong>{CLASSIFICATION_LABELS[ruleSuggestion]}</strong> for this merchant.{' '}
                      <button className="btn-small btn-ghost" style={{ display: 'inline-block' }} onClick={() => confirmGroupAction(group, ruleSuggestion, CLASSIFICATION_LABELS[ruleSuggestion])}>Apply Rule</button>
                    </p>
                  )}
                  <div className="action-row">
                    <button className="btn-small" onClick={() => confirmGroupAction(group, 'company_candidate', CLASSIFICATION_LABELS.company_candidate)}>Confirm All as Company</button>
                    <button className="btn-small btn-ghost" onClick={() => confirmGroupAction(group, 'personal', CLASSIFICATION_LABELS.personal)}>Mark All Personal</button>
                    <button className="btn-small btn-ghost" onClick={() => sendGroupToAccountant(group)}>Send to Accountant Review</button>
                    <button className="btn-small btn-ghost" onClick={() => setExpandedMerchant(expanded ? null : group.key)}>
                      {expanded ? 'Hide' : 'Open Exceptions'}
                    </button>
                  </div>

                  {expanded && (
                    <div className="txn-detail-box">
                      <div className="txn-detail-scroll">
                        <div className="mobile-only">
                          {group.txns.map(txn => {
                            const draft = purposeDraft[txn.id] || {}
                            return (
                              <div key={txn.id} className="expense-mob-card">
                                <div className="mob-card-header">
                                  <span className="mob-card-vendor">{txn.merchantRaw}</span>
                                  <span className="mob-card-amount" data-amount="true">{txn.direction === 'debit' ? '-' : '+'}{txn.settlementAmount?.toFixed(2)}</span>
                                </div>
                                <div className="mob-card-sub">
                                  <span className="mob-card-date">{txn.transactionDate}</span>
                                  <span className={`badge ${CLASSIFICATION_BADGE_CLASS[txn.classification] || 'badge-other'}`}>{CLASSIFICATION_LABELS[txn.classification]}</span>
                                </div>
                                <div className="action-row" style={{ marginTop: 6 }}>
                                  <select value={txn.classification} disabled={busyId === txn.id} onChange={e => setTxnClassification(txn, e.target.value)}>
                                    {Object.entries(CLASSIFICATION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                  </select>
                                </div>
                                <div className="action-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                                  {BUSINESS_PURPOSE_OPTIONS.map(opt => (
                                    <button
                                      key={opt}
                                      className={`btn-small${draft.option === opt ? ' btn-primary' : ' btn-ghost'}`}
                                      onClick={() => setPurposeDraft(p => ({ ...p, [txn.id]: { ...p[txn.id], option: opt } }))}
                                    >{opt}</button>
                                  ))}
                                </div>
                                <input
                                  placeholder="Optional note"
                                  value={draft.note || ''}
                                  onChange={e => setPurposeDraft(p => ({ ...p, [txn.id]: { ...p[txn.id], note: e.target.value } }))}
                                  onBlur={() => saveBusinessPurpose(txn)}
                                  style={{ marginTop: 6 }}
                                />
                                {txn.businessPurpose && <div className="hint">Saved: {txn.businessPurpose}</div>}
                                <div className="mob-card-actions">
                                  {txn.status !== 'matched' && (
                                    <button className="btn-small" disabled={busyId === txn.id} onClick={() => createExpenseFromTxn(txn)}>Create Expense</button>
                                  )}
                                  {txn.status === 'matched' && <span className="hint">Linked to Expense</span>}
                                </div>
                              </div>
                            )
                          })}
                        </div>

                        <table className="txn-table-compact desktop-only">
                          <thead>
                            <tr><th>Date</th><th>Merchant</th><th>Amount</th><th>Classification</th><th>Business Purpose</th><th>Actions</th></tr>
                          </thead>
                          <tbody>
                            {group.txns.map(txn => {
                              const draft = purposeDraft[txn.id] || {}
                              return (
                                <tr key={txn.id}>
                                  <td>{txn.transactionDate}</td>
                                  <td>{txn.merchantRaw}</td>
                                  <td data-amount="true">{txn.direction === 'debit' ? '-' : '+'}{txn.settlementAmount?.toFixed(2)}</td>
                                  <td>
                                    <select value={txn.classification} disabled={busyId === txn.id} onChange={e => setTxnClassification(txn, e.target.value)}>
                                      {Object.entries(CLASSIFICATION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                    </select>
                                  </td>
                                  <td>
                                    <div className="action-row" style={{ flexWrap: 'wrap', marginBottom: 4 }}>
                                      {BUSINESS_PURPOSE_OPTIONS.map(opt => (
                                        <button
                                          key={opt}
                                          className={`btn-small${draft.option === opt ? ' btn-primary' : ' btn-ghost'}`}
                                          onClick={() => setPurposeDraft(p => ({ ...p, [txn.id]: { ...p[txn.id], option: opt } }))}
                                        >{opt}</button>
                                      ))}
                                    </div>
                                    <input
                                      placeholder="Optional note"
                                      value={draft.note || ''}
                                      onChange={e => setPurposeDraft(p => ({ ...p, [txn.id]: { ...p[txn.id], note: e.target.value } }))}
                                      onBlur={() => saveBusinessPurpose(txn)}
                                    />
                                    {txn.businessPurpose && <div className="hint">Saved: {txn.businessPurpose}</div>}
                                  </td>
                                  <td>
                                    {txn.status !== 'matched'
                                      ? <button className="btn-small" disabled={busyId === txn.id} onClick={() => createExpenseFromTxn(txn)}>Create Expense</button>
                                      : <span className="hint">Linked to Expense</span>}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          confirmClassName={confirmDialog.confirmClassName}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
          extraLabel={confirmDialog.extraLabel}
          extraClassName={confirmDialog.extraClassName}
          onExtra={confirmDialog.onExtra}
        />
      )}
    </div>
  )
}
