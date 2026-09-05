// Pure, dependency-free classification for transactions on a *personal*
// bank/card account that mixes personal spending with company-related
// spending. Deliberately conservative: this app never auto-decides a final
// claim, tax category, or allocation — every ambiguous transaction lands in
// 'needs_accountant_review' rather than being guessed at. See
// LESSONS_LEARNED.md's duplicate-detection entry for the same philosophy
// applied earlier in this codebase.
//
// Phase 2 adds merchant rules (a `merchantRules` Firestore doc per merchant,
// built from a user's bulk classification — see CompanyReview.jsx). A rule
// is a SUGGESTION by default: it never silently reclassifies a transaction
// unless the user has explicitly turned on Auto-Approve for that specific
// merchant. This mirrors how AI suggestions are treated elsewhere in this
// app — propose, never silently overwrite/auto-confirm.

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

// Deterministic doc id for a merchant rule — one rule per (project,
// merchant), upserted rather than accumulating duplicates every time a
// group is bulk-confirmed with "save as rule" checked.
export function merchantRuleDocId(projectId, merchantKey) {
  return `${projectId}__${merchantKey}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// Priority order (spec §5.1, trimmed to what Phase 1+2 actually have):
//   1. A merchant rule with Auto-Approve on — the user explicitly opted this
//      merchant into automatic classification, so it wins outright.
//   2. Already linked to a matched Expense — real evidence, not a guess.
//   3. Otherwise 'needs_accountant_review' — the conservative default.
// A rule that exists but is NOT Auto-Approve never changes `classification`
// — it's carried as `suggestedClassification` so the UI can offer a
// one-click "Apply Rule" action without ever auto-deciding for the user.
export function classifyTransaction(txn, { matchedExpenseId = null, rule = null } = {}) {
  if (CLASSIFICATION_EXCLUDED_TYPES.includes(txn.transactionType)) return null

  const suggestedClassification = rule ? rule.classification : null

  if (rule?.autoApprove) {
    return {
      classification: rule.classification,
      classificationConfidence: rule.confidence ?? 0.95,
      classificationSource: 'merchant_rule',
      suggestedClassification: null, // already applied, nothing left to suggest
    }
  }

  if (matchedExpenseId) {
    return {
      classification: 'company_candidate',
      classificationConfidence: 0.9,
      classificationSource: 'match',
      suggestedClassification,
    }
  }

  return {
    classification: 'needs_accountant_review',
    classificationConfidence: null,
    classificationSource: null,
    suggestedClassification,
  }
}

// Whether a personal-account transaction is visible to a non-owner project
// collaborator (see src/lib/projectAccess.js). Only a confirmed non-personal
// classification unlocks visibility — unclassified and 'personal' rows stay
// hidden, per the explicit requirement that a shared project never exposes
// the owner's personal spending. Call this everywhere `classification` is
// written on a paymentTransactions doc for a personal account.
export function computeVisibleToMembers(classification) {
  return classification != null && classification !== 'personal'
}
