// Pure, dependency-free helpers for Phase 1 payment reconciliation:
// CSV parsing, row classification, fingerprinting, and rule-based match
// scoring. No network calls, no Firestore access — callers wire this to
// data. Kept deterministic and explainable per the reconciliation spec
// (payment-reconciliation-spec-v1.md) — no LLM involved in matching.

// ---- CSV parsing --------------------------------------------------------

// Minimal RFC4180-ish CSV parser: handles quoted fields, embedded commas,
// and escaped quotes ("" inside a quoted field). Good enough for standard
// bank/card CSV exports; not a full spec implementation.
export function parseCSV(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { pushField(); rows.push(row); row = [] }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') pushField()
    else if (c === '\n') { if (field !== '' || row.length) pushRow() }
    else if (c === '\r') { /* skip, \n handles the row break */ }
    else field += c
  }
  if (field !== '' || row.length) pushRow()

  if (!rows.length) return { headers: [], records: [] }
  const headers = rows[0].map(h => h.trim())
  const records = rows.slice(1)
    .filter(r => r.some(v => v.trim() !== ''))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])))
  return { headers, records }
}

const COLUMN_ALIASES = {
  date: ['date', 'transaction date', 'trans date', 'txn date', 'posting date'],
  postDate: ['posting date', 'post date', 'value date'],
  description: ['description', 'narrative', 'merchant', 'details', 'particulars', 'transaction details'],
  amount: ['amount', 'transaction amount'],
  debit: ['debit', 'withdrawal', 'debit amount'],
  credit: ['credit', 'deposit', 'credit amount'],
  balance: ['balance', 'running balance', 'closing balance'],
}

function findColumn(headers, aliases) {
  const lower = headers.map(h => h.toLowerCase())
  for (const alias of aliases) {
    const i = lower.indexOf(alias)
    if (i !== -1) return headers[i]
  }
  return null
}

// Tolerant date parser for common bank export formats. Returns ISO
// YYYY-MM-DD, or null if unparseable — callers must handle null rather
// than guess, per the "don't silently invent data" principle.
export function parseStatementDate(raw) {
  if (!raw) return null
  const s = raw.trim()
  // DD/MM/YYYY or DD-MM-YYYY (assume day-first, the common HK bank format)
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (m) {
    const [, d, mo, y] = m
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // YYYY-MM-DD already
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  // "04 Sep 2026" style
  const parsed = new Date(s)
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  return null
}

// Maps parsed CSV records into the paymentTransactions row shape (minus
// ids/timestamps, which the caller assigns on write). Handles either a
// single signed `amount` column or separate `debit`/`credit` columns.
export function mapCsvRecords(records, headers) {
  const dateCol = findColumn(headers, COLUMN_ALIASES.date)
  const postDateCol = findColumn(headers, COLUMN_ALIASES.postDate)
  const descCol = findColumn(headers, COLUMN_ALIASES.description)
  const amountCol = findColumn(headers, COLUMN_ALIASES.amount)
  const debitCol = findColumn(headers, COLUMN_ALIASES.debit)
  const creditCol = findColumn(headers, COLUMN_ALIASES.credit)
  const balanceCol = findColumn(headers, COLUMN_ALIASES.balance)

  return records.map((rec, i) => {
    const rawDateText = rec[dateCol] || ''
    let settlementAmount = null
    let direction = null

    if (debitCol || creditCol) {
      const debitVal = parseFloat((rec[debitCol] || '').replace(/[,$]/g, ''))
      const creditVal = parseFloat((rec[creditCol] || '').replace(/[,$]/g, ''))
      if (!isNaN(debitVal) && debitVal !== 0) { settlementAmount = Math.abs(debitVal); direction = 'debit' }
      else if (!isNaN(creditVal) && creditVal !== 0) { settlementAmount = Math.abs(creditVal); direction = 'credit' }
    } else if (amountCol) {
      const val = parseFloat((rec[amountCol] || '').replace(/[,$]/g, ''))
      if (!isNaN(val)) { settlementAmount = Math.abs(val); direction = val < 0 ? 'debit' : 'credit' }
    }

    return {
      sourceRowIndex: i,
      rawRowText: JSON.stringify(rec),
      rawDateText,
      transactionDate: parseStatementDate(rawDateText),
      postDate: postDateCol ? parseStatementDate(rec[postDateCol]) : null,
      merchantRaw: descCol ? rec[descCol] : '',
      settlementAmount,
      direction,
      balanceAfter: balanceCol && rec[balanceCol] ? (isNaN(parseFloat(rec[balanceCol].replace(/[,$]/g, ''))) ? null : parseFloat(rec[balanceCol].replace(/[,$]/g, ''))) : null,
    }
  }).filter(t => t.settlementAmount != null && t.direction != null)
}

// ---- Normalization & classification --------------------------------------

export function normalizeMerchant(raw) {
  if (!raw) return ''
  return raw
    .toLowerCase()
    .replace(/\d{4,}/g, '')          // strip long digit runs (terminal/card IDs)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation, keep unicode letters/digits
    .replace(/\s+/g, ' ')
    .trim()
}

const PAYMENT_KEYWORDS = /payment received|payment - thank you|thank you for your payment|online payment|paid by autopay|\bpayment\b/i
const REFUND_KEYWORDS = /refund|reversal|credit adjustment|return/i
const FEE_KEYWORDS = /annual fee|late fee|service charge|handling fee|fx fee|foreign transaction fee|admin fee|dcc fee/i
const INTEREST_KEYWORDS = /finance charge|interest charge|interest\b/i
const CASH_KEYWORDS = /cash advance|atm withdrawal/i
const TRANSFER_KEYWORDS = /balance transfer|funds transfer/i

// Classifies a row into the Phase 1 transactionType enum using keyword
// rules on the description plus direction — no model call, fully
// explainable (spec §4).
export function classifyTransactionType(merchantRaw, direction) {
  const text = merchantRaw || ''
  // A settlement payment always reduces the balance it's paid against —
  // it's a credit-direction row. A debit row that happens to mention
  // "payment" (e.g. "HKT AUTOPAY 52300" — a phone bill autopaid BY the
  // card) is a purchase, not a card-balance payment — direction disambiguates.
  if (direction === 'credit' && PAYMENT_KEYWORDS.test(text)) return 'payment'
  if (REFUND_KEYWORDS.test(text)) return 'refund'
  if (FEE_KEYWORDS.test(text)) return 'fee'
  if (INTEREST_KEYWORDS.test(text)) return 'interest'
  if (CASH_KEYWORDS.test(text)) return 'cash_withdrawal'
  if (TRANSFER_KEYWORDS.test(text)) return 'transfer'
  if (direction === 'credit') return 'refund' // unlabelled credit on a card/bank row is most often a refund
  if (direction === 'debit') return 'purchase'
  return 'unknown'
}

// SHA-256 hex digest via SubtleCrypto (available in all evergreen
// browsers over https, which is all this app runs on). Async because
// SubtleCrypto is async — callers must await.
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function computeFingerprints({ projectId, accountId, transactionDate, merchantNormalized, settlementAmount, direction, settlementCurrency }) {
  const exact = await sha256Hex([projectId, accountId, transactionDate, merchantNormalized, settlementAmount, direction, settlementCurrency].join('|'))
  const dateBucket = (transactionDate || '').slice(0, 7) // year-month
  const loose = await sha256Hex([projectId, Math.abs(settlementAmount), merchantNormalized.split(' ')[0] || '', settlementCurrency, dateBucket].join('|'))
  return { fingerprintExact: exact, fingerprintLoose: loose }
}

function daysBetween(a, b) {
  if (!a || !b) return null
  return Math.abs((new Date(a) - new Date(b)) / 86400000)
}

export function merchantSimilarity(a, b) {
  const na = normalizeMerchant(a), nb = normalizeMerchant(b)
  if (!na || !nb) return 'none'
  if (na === nb || na.includes(nb) || nb.includes(na)) return 'high'
  const wordsA = new Set(na.split(' ').filter(w => w.length > 2))
  const wordsB = nb.split(' ').filter(w => w.length > 2)
  if (wordsB.some(w => wordsA.has(w))) return 'medium'
  return 'none'
}

// ---- Matching: transaction -> expense ------------------------------------

// Scores a transaction against a candidate expense per spec §5. Returns
// null if the transaction isn't even eligible to match (wrong type,
// pending, already claimed elsewhere) — callers should skip nulls
// rather than show a 0-score card.
// A statement transaction and its matching Expense record should always be
// close in time — same day, typically, or a few days for statement posting
// lag. Amount and currency alone (no date proximity, no merchant
// similarity) were previously enough to clear the suggestion threshold —
// e.g. a personal bank transfer scoring 65 against an unrelated software
// subscription four years later, purely because both happened to be HKD
// 250. A pairing this far apart in time is never a genuine match regardless
// of what else lines up, so it's disqualified outright rather than merely
// scored lower.
export const MAX_MATCH_DAYS = 90

export function scoreExpenseMatch(txn, expense) {
  if (!['purchase', 'fee', 'interest'].includes(txn.transactionType)) return null
  if (txn.pendingOrPosted === 'pending') return null

  const days = daysBetween(txn.transactionDate, expense.date)
  if (days !== null && days > MAX_MATCH_DAYS) return null

  let score = 0
  const reasons = []

  const amtMatch = Math.abs(txn.settlementAmount - parseFloat(expense.amount)) < 0.01
  if (amtMatch) { score += 45; reasons.push('Same amount') }
  else { reasons.push('Amount does not match') }

  if (txn.settlementCurrency === expense.currency) { score += 15; reasons.push('Same currency') }

  if (days === 0) { score += 15; reasons.push('Same date') }
  else if (days !== null && days <= 3) { score += 10; reasons.push(`Date within ${Math.ceil(days)} day(s)`) }
  else if (days !== null) { reasons.push(`Date differs by ${Math.ceil(days)} day(s)`) }

  const sim = merchantSimilarity(txn.merchantRaw, expense.vendor)
  if (sim === 'high') { score += 20; reasons.push('Merchant name matches closely') }
  else if (sim === 'medium') { score += 10; reasons.push('Merchant name partially matches') }
  else { reasons.push('Merchant name does not match') }

  if (txn.transactionType === 'purchase') { score += 5 }

  if (expense.matchedPaymentTransactionId) { score -= 50; reasons.push('Expense already matched to another transaction') }

  return { score, reasons }
}

// ---- Matching: transaction -> sales invoice (income) ---------------------

// Mirrors scoreExpenseMatch exactly, but for the income side: a bank/card
// CREDIT matched against a customer invoice, instead of a debit matched
// against an expense. Excludes 'payment'-type credits (card-balance
// payments) — those belong to settlement linking, not income.
export function scoreInvoiceMatch(txn, invoice) {
  if (txn.direction !== 'credit') return null
  if (txn.transactionType === 'payment') return null
  if (txn.pendingOrPosted === 'pending') return null

  const days = daysBetween(txn.transactionDate, invoice.date)
  if (days !== null && days > MAX_MATCH_DAYS) return null

  let score = 0
  const reasons = []

  const amtMatch = Math.abs(txn.settlementAmount - parseFloat(invoice.amount)) < 0.01
  if (amtMatch) { score += 45; reasons.push('Same amount') }
  else { reasons.push('Amount does not match') }

  if (txn.settlementCurrency === invoice.currency) { score += 15; reasons.push('Same currency') }

  if (days === 0) { score += 15; reasons.push('Same date') }
  else if (days !== null && days <= 3) { score += 10; reasons.push(`Date within ${Math.ceil(days)} day(s)`) }
  else if (days !== null) { reasons.push(`Date differs by ${Math.ceil(days)} day(s)`) }

  const sim = merchantSimilarity(txn.merchantRaw, invoice.counterpartyName)
  if (sim === 'high') { score += 20; reasons.push('Customer name matches closely') }
  else if (sim === 'medium') { score += 10; reasons.push('Customer name partially matches') }
  else { reasons.push('Customer name does not match') }

  if (invoice.matchedPaymentTransactionId) { score -= 50; reasons.push('Invoice already matched to another transaction') }

  return { score, reasons }
}

// ---- Matching: card payment -> bank debit (settlement linking) ----------

// Scores a credit-card `payment` row against a bank `debit` row per spec
// §6. This is the double-count guard: only these two ever link this way,
// and a linked pair is permanently excluded from expense matching.
export function scoreSettlementMatch(cardTxn, bankTxn) {
  if (cardTxn.transactionType !== 'payment' || bankTxn.direction !== 'debit') return null

  let score = 0
  const reasons = []

  if (Math.abs(cardTxn.settlementAmount - bankTxn.settlementAmount) < 0.01) { score += 60; reasons.push('Same amount') }
  if (cardTxn.settlementCurrency === bankTxn.settlementCurrency) { score += 15; reasons.push('Same currency') }

  const days = daysBetween(cardTxn.transactionDate, bankTxn.transactionDate)
  if (days === 0) { score += 15; reasons.push('Same date') }
  else if (days !== null && days <= 3) { score += 10; reasons.push(`Date within ${Math.ceil(days)} day(s)`) }

  if (/visa|mastercard|amex|card/i.test(bankTxn.merchantRaw || '')) { score += 10; reasons.push('Bank description references a card payment') }

  if (cardTxn.settlementGroupId || bankTxn.settlementGroupId) { score -= 50; reasons.push('Already linked to another settlement') }

  return { score, reasons }
}

// ---- Needs Review classification ------------------------------------------

// Transaction types that are never a business expense — Create Expense must
// be blocked for these unless the user explicitly overrides (spec §5/§6).
export const CREATE_EXPENSE_BLOCKED_TYPES = ['payment', 'transfer']

// Buckets a Needs Review row into one of the categories from spec §6, so the
// UI can show a specific reason instead of treating every low-score
// suggestion as a generic possible expense. `hasDuplicate` is computed by
// the caller (a fingerprintLoose collision among a project's active rows).
export function classifyReviewCategory(txn, { hasDuplicate = false } = {}) {
  if (txn.transactionType === 'payment') return 'possible_settlement'
  if (txn.transactionType === 'transfer') return 'possible_transfer'
  // Checked before the 'refund' fallback below: an unlabelled credit
  // defaults to transactionType 'refund' (classifyTransactionType), but a
  // credit with an invoice suggestion attached is far more likely a
  // customer payment than a genuine refund — an actual unmatched refund
  // still falls through to 'possible_refund' as before.
  if (txn.direction === 'credit' && txn.confidenceScore != null) return 'possible_income'
  if (txn.transactionType === 'refund') return 'possible_refund'
  if (hasDuplicate) return 'possible_duplicate'
  if (txn.confidenceScore != null) return 'possible_expense'
  return 'unclear'
}
