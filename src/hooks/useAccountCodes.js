import { useState, useEffect } from 'react'
import { collection, query, where, onSnapshot, doc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { accountCodeRuleDocId } from '../lib/accountCodes'
import { normalizeMerchant } from '../lib/paymentMatching'

// Shared subscription for Account Codes + their suggestion rules (Finance
// repositioning MVP-3) — used by Upload.jsx, Income.jsx, and Expenses.jsx,
// all of which need the same project-scoped chart + rule list. Kept as a
// hook (not a page-embedded onSnapshot, this app's usual pattern) purely
// to avoid tripling this exact boilerplate across three pages; the actual
// Firestore read/write for the RECORD itself still lives in each page.
export function useAccountCodes(projectId) {
  const [accountCodes, setAccountCodes] = useState([])
  const [rules, setRules] = useState([])

  useEffect(() => {
    if (!projectId) { setAccountCodes([]); setRules([]); return }
    const unsubC = onSnapshot(
      query(collection(db, 'accountCodes'), where('projectId', '==', projectId)),
      snap => setAccountCodes(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubR = onSnapshot(
      query(collection(db, 'accountCodeRules'), where('projectId', '==', projectId)),
      snap => setRules(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    return () => { unsubC(); unsubR() }
  }, [projectId])

  return { accountCodes, rules }
}

// Upserts the "remember this code for <vendor>" rule — one rule per
// (project, merchant, recordType), same idempotent-on-re-confirm pattern
// as merchantRules in expenseClassification.js.
export async function saveAccountCodeRule(projectId, counterpartyName, recordType, { accountCodeId, accountCode, accountName }) {
  const merchantKey = normalizeMerchant(counterpartyName)
  if (!merchantKey) return
  await setDoc(doc(db, 'accountCodeRules', accountCodeRuleDocId(projectId, merchantKey, recordType)), {
    projectId,
    merchantKey,
    merchantLabel: counterpartyName,
    recordType,
    accountCodeId, accountCode, accountName,
    source: 'user_confirmed',
    lastConfirmedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    createdBy: auth.currentUser?.uid || null,
  }, { merge: true })
}
