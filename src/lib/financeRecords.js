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

// Resolves the single record a paymentTransactions row is matched to,
// across all four match targets (expense, income, sales invoice, purchase
// order) — the same four fields Reconciliation.jsx's own
// selectedExpense/selectedInvoice/selectedPo/selectedIncome already resolve
// inline. Checked in this order because a transaction only ever carries one
// of these at a time (status:'matched' removes it from every other match
// pool). Returns null if none resolve (matched to a settlement group, or
// the linked record was deleted since matching).
export function resolveMatchedRecord(txn, { expenses = [], invoices = [], purchaseOrders = [], income = [] } = {}) {
  if (!txn) return null
  const expenseId = txn.matchedExpenseIds?.[0]
  if (expenseId) {
    const record = expenses.find(e => e.id === expenseId)
    if (record) return { recordType: 'expense', record }
  }
  const invoiceId = txn.matchedInvoiceIds?.[0]
  if (invoiceId) {
    const record = invoices.find(inv => inv.id === invoiceId)
    if (record) return { recordType: 'invoice', record }
  }
  if (txn.matchedPoId) {
    const record = purchaseOrders.find(po => po.id === txn.matchedPoId)
    if (record) return { recordType: 'po', record }
  }
  if (txn.matchedIncomeId) {
    const record = income.find(inc => inc.id === txn.matchedIncomeId)
    if (record) return { recordType: 'income', record }
  }
  return null
}

// Month-End Report (MVP-6) — a record-side counterpart to
// reconciliationStatusLabel() (paymentMatching.js, transaction-side). Pure
// display mapping onto existing fields, same "best-effort now" precedent —
// 'Needs Review'/'sync-failed' from the spec's fuller vocabulary have no
// clean per-record meaning across all four FinanceRecord collections
// (needs_accountant_review only exists on Expense-side bank
// classification; sync-failed is a project-level Operation Center status,
// not a per-record one), so they're not modeled here. No stored field
// changes — reads settlementStatus/receiptStatus/reconciliationStatus,
// already written by Upload.jsx/Income.jsx/Invoices.jsx/Reconciliation.jsx.
export function recordReconciliationStatus(record) {
  if (!record) return 'Unreconciled'
  if (record.reconciliationStatus === 'created_from_statement' && record.receiptStatus === 'missing') {
    return 'Missing Document'
  }
  if (record.settlementStatus === 'confirmed') return 'Reconciled'
  return 'Unreconciled'
}
