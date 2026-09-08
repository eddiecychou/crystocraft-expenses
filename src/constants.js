export const CATEGORIES = ['Travel', 'Meals', 'Office', 'Software', 'Utilities', 'Development', 'Marketing', 'Professional Services', 'Equipment', 'Bank Charges', 'Production', 'Other']
export const CURRENCIES = ['HKD', 'RMB', 'USD', 'EUR', 'JPY', 'AUD', 'GBP', 'SGD', 'CAD', 'KRW', 'Other']
// This app is now shared across companies — Categories and Payment
// Methods are per-project (projects.categories / projects.paymentMethods,
// editable in Settings), not one global list. PAYMENT_METHODS below is
// the FALLBACK for a project with no paymentMethods field yet (every
// project that predates this feature, so existing behavior doesn't
// change until someone actually edits it in Settings) — it still carries
// this project's own entries (X Transfer, Eddie - WeChat, etc.), which
// is exactly why a NEW project must never inherit it; see
// DEFAULT_PAYMENT_METHODS. CATEGORIES has nothing company-specific in it,
// so it doubles as both the fallback and the new-project starter list.
export const PAYMENT_METHODS = ['Credit Card HK', 'Bank Account HK', 'Alipay', 'WeChat Pay', 'Bank Account CN', 'Cash', 'X Transfer', 'HKBC C/A', 'HKBC S/A', 'Eddie - WeChat', 'Eddie - ICBC']
// Seeded onto a brand-new project's paymentMethods field at creation —
// the original generic list, before this project's own company-specific
// entries were added to PAYMENT_METHODS above.
export const DEFAULT_PAYMENT_METHODS = ['Credit Card HK', 'Bank Account HK', 'Alipay', 'WeChat Pay', 'Bank Account CN', 'Cash']
export const PAYMENT_STAGES = ['Full Payment', 'Deposit', 'Balance']
// Income (Finance repositioning MVP-2) — non-Operation-Center income only;
// customer sales already covered by an OC invoice live in salesInvoices,
// not here. Plain list for now, same as CATEGORIES before Account Codes
// (MVP-3) replace both.
export const INCOME_CATEGORIES = ['Rental Income', 'Bank Interest', 'Refund', 'Other Income']

export function projectCategories(project) {
  return project?.categories?.length ? project.categories : CATEGORIES
}
export function projectPaymentMethods(project) {
  return project?.paymentMethods?.length ? project.paymentMethods : PAYMENT_METHODS
}
