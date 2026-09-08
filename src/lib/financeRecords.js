// Shared shape for the two same-level financial objects this app now
// manages: Expenses and Income (Finance / Bookkeeping Center repositioning,
// see the spec + TECHNICAL.md). Deliberately a CODE-level unification only:
// expenses physically live in the `expenses` collection and income (from
// MVP-2) in `income`, each with their own Firestore rules and Storage
// paths. This module is the seam that lets a unified view treat them as one
// `FinanceRecord` list without a risky physical collection merge.

export const RECORD_TYPES = { EXPENSE: 'expense', INCOME: 'income' }

/**
 * @typedef {Object} FinanceRecord
 * @property {string} id
 * @property {string} projectId               // == companyId in spec terms
 * @property {'expense'|'income'} recordType
 * @property {number} amount
 * @property {string} currency
 * @property {string} [date]                   // transactionDate, YYYY-MM-DD
 * @property {string} [vendor]                 // counterparty (expense: vendor, income: payer)
 * @property {string} [category]
 * @property {string} [accountCode]            // MVP-3
 * @property {string} [notes]
 * @property {'finance_upload'|'bank_transaction'|'operation_center'|'manual'} [source]
 * @property {string} [matchedPaymentTransactionId]
 * @property {string} [settlementStatus]
 * // ...plus every existing expense field, carried through untouched.
 */

// Reads a Firestore expense/income doc into a FinanceRecord, stamping
// recordType with the expense fallback — existing expense docs predate the
// field, and the `expenses` collection is 100% expenses by definition, so a
// missing value always means 'expense'. No migration needed.
export function readFinanceRecord(id, data, recordType) {
  return { id, ...data, recordType: data.recordType || recordType || RECORD_TYPES.EXPENSE }
}
