// Account Codes (Finance repositioning MVP-3) — pure helpers shared by
// AccountCodePicker.jsx, AccountCodes.jsx, and every page that lets a user
// assign a code to an expense/income record.

// Which account-code types are even offerable for a given record side —
// per the spec (§7): an expense record can only ever suggest expense,
// asset, liability, or other; an income record only income or other. A
// picker never even shows a code outside its own side, let alone lets one
// be selected.
export const ELIGIBLE_TYPES_FOR_RECORD = {
  expense: ['expense', 'asset', 'liability', 'other'],
  income: ['income', 'other'],
}

// Deterministic doc id for an account-code rule — one rule per
// (project, merchant, recordType), upserted rather than accumulating
// duplicates. Same pattern as merchantRuleDocId in expenseClassification.js.
export function accountCodeRuleDocId(projectId, merchantKey, recordType) {
  return `${projectId}__${merchantKey}__${recordType}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// A rule is always a SUGGESTION, never auto-applied — there is no
// autoApprove concept at all for account codes (unlike Merchant Rules),
// per the spec's explicit call-out that account coding needs human
// confirmation for salary/tax/related-party/capital items. The caller
// still shows this in an editable field, never locks it in.
export function suggestAccountCode(merchantKey, recordType, rules) {
  if (!merchantKey) return null
  const rule = rules.find(r => r.merchantKey === merchantKey && r.recordType === recordType)
  return rule ? { accountCodeId: rule.accountCodeId, accountCode: rule.accountCode, accountName: rule.accountName } : null
}
