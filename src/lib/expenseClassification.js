// Pure, dependency-free classification for transactions on a *personal*
// bank/card account that mixes personal spending with company-related
// spending. Deliberately conservative: this app never auto-decides a final
// claim, tax category, or allocation — every ambiguous transaction lands in
// 'needs_accountant_review' rather than being guessed at. See
// LESSONS_LEARNED.md's duplicate-detection entry for the same philosophy
// applied earlier in this codebase.
//
// Phase 1 scope: no merchant-rule/history table exists yet (that's Phase 2),
// so the only automatic classification is "already matched to an Expense"
// evidence. Everything else is surfaced for a human to confirm, which is
// itself what will eventually build the Phase 2 rule history.

import { CREATE_EXPENSE_BLOCKED_TYPES } from './paymentMatching'

export const CLASSIFICATION_LABELS = {
  personal: 'Personal',
  company_candidate: 'Company Candidate',
  company_confirmed: 'Company Confirmed',
  shared: 'Shared',
  needs_accountant_review: 'Needs Accountant Review',
  rejected_company_claim: 'Rejected Company Claim',
}

export const BUSINESS_PURPOSE_OPTIONS = [
  'Customer meeting',
  'Business travel',
  'Software / subscription',
  'Sample / sourcing',
  'Office / operations',
  'Other',
]

// Transaction types that are never business-expense candidates on a
// personal account (card repayments, internal transfers) — reuses the same
// exclusion list Reconciliation.jsx already applies to "Create Expense from
// Transaction", so a row can't be a Company Candidate here but blocked from
// becoming an Expense there.
export const CLASSIFICATION_EXCLUDED_TYPES = CREATE_EXPENSE_BLOCKED_TYPES

// Returns null for excluded transaction types (payment/transfer) — callers
// should skip classification entirely for those rows, same as how they're
// already excluded from ordinary reconciliation.
export function classifyTransaction(txn, { matchedExpenseId = null } = {}) {
  if (CLASSIFICATION_EXCLUDED_TYPES.includes(txn.transactionType)) return null

  if (matchedExpenseId) {
    return {
      classification: 'company_candidate',
      classificationConfidence: 0.9,
      classificationSource: 'match',
    }
  }

  return {
    classification: 'needs_accountant_review',
    classificationConfidence: null,
    classificationSource: null,
  }
}
