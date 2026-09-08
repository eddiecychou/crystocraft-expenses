// CSV column mapping for the two document types Invoices.jsx imports:
// customer invoices (income) and supplier purchase orders (expense-side
// commitments). Deliberately header-level only (no line items) for Phase 1
// — see LESSONS_LEARNED.md. Reuses parseCSV/parseStatementDate from
// paymentMatching.js rather than re-implementing CSV tokenizing or date
// parsing.
import { parseStatementDate } from './paymentMatching'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { storage } from '../firebase'

const NUMBER_ALIASES = {
  invoice: ['invoice no', 'invoice #', 'invoice number', 'inv no', 'inv #', 'si #', 'si no', 'si number', 'number'],
  po: ['po no', 'po #', 'po number', 'purchase order no', 'purchase order number', 'pu no', 'pu #', 'number'],
}
const COUNTERPARTY_ALIASES = {
  invoice: ['customer', 'customer name', 'client', 'bill to', 'counterparty'],
  po: ['supplier', 'supplier name', 'vendor', 'vendor name', 'counterparty'],
}
// Distinct from the counterparty NAME above — e.g. an ERP's short internal
// code for the customer/supplier ("H37", "C13"), a separate column from
// the name in both of this app's real source exports (Costing Tool's
// "Customer code"/"Supplier code").
const CODE_ALIASES = {
  invoice: ['customer code', 'client code'],
  po: ['supplier code', 'vendor code'],
}
const DATE_ALIASES = ['date', 'invoice date', 'po date', 'order date', 'issue date', 'issued']
const AMOUNT_ALIASES = ['amount', 'total', 'invoice amount', 'amount due', 'order total', 'grand total']
const CURRENCY_ALIASES = ['currency', 'curr']
const NOTES_ALIASES = ['notes', 'remarks', 'description', 'memo']

// Was an exact-match-only lookup — real exports routinely differ by a
// trailing period or extra word ("PU No." vs the alias "pu no"), which
// silently left the whole column unrecognized. Substring match in both
// directions, same fix as the equivalent bug already found in
// paymentMatching.js's findColumn (see LESSONS_LEARNED.md).
function findColumn(headers, aliases) {
  const lower = headers.map(h => h.toLowerCase())
  for (const alias of aliases) {
    const i = lower.findIndex(h => h === alias || h.includes(alias))
    if (i !== -1) return headers[i]
  }
  return null
}

// Excel forces a value to be read back as text (rather than re-interpreted
// as a number/date/formula) by wrapping it as ="the value" — common for
// reference numbers and codes that start with letters or have leading
// zeros. Both of this app's real source exports (Costing Tool's PU/UC
// registries) do this for every number and code column. Left un-stripped,
// a PO number would be saved as the literal text `="PU260055"`.
function stripExcelFormulaText(v) {
  if (!v) return v
  const m = v.trim().match(/^="(.*)"$/)
  return m ? m[1] : v
}

// Maps parsed CSV records into the salesInvoices/purchaseOrders row shape
// (minus ids/timestamps, which the caller assigns on write). `kind` is
// 'invoice' or 'po' — only the column aliases and output field name for
// the counterparty/number differ between the two.
export function mapDocumentCsvRecords(records, headers, kind) {
  const numberCol = findColumn(headers, NUMBER_ALIASES[kind])
  const counterpartyCol = findColumn(headers, COUNTERPARTY_ALIASES[kind])
  const codeCol = findColumn(headers, CODE_ALIASES[kind])
  const dateCol = findColumn(headers, DATE_ALIASES)
  const amountCol = findColumn(headers, AMOUNT_ALIASES)
  const currencyCol = findColumn(headers, CURRENCY_ALIASES)
  const notesCol = findColumn(headers, NOTES_ALIASES)

  return records.map((rec, i) => {
    const amountRaw = amountCol ? parseFloat((rec[amountCol] || '').replace(/[,$]/g, '')) : NaN
    return {
      sourceRowIndex: i,
      number: numberCol ? stripExcelFormulaText((rec[numberCol] || '').trim()) : '',
      counterpartyName: counterpartyCol ? (rec[counterpartyCol] || '').trim() : '',
      counterpartyCode: codeCol ? stripExcelFormulaText((rec[codeCol] || '').trim()) : '',
      date: dateCol ? parseStatementDate(rec[dateCol]) : null,
      amount: isNaN(amountRaw) ? null : amountRaw,
      currency: currencyCol ? (rec[currencyCol] || '').trim().toUpperCase() : 'HKD',
      notes: notesCol ? (rec[notesCol] || '').trim() : '',
    }
  }).filter(r => r.amount != null)
}

// Deterministic Firestore doc id for an Operation Center-synced record,
// keyed on OC's own PU#/SI# — re-syncing the same OC record always writes
// the same doc (via setDoc merge), so a re-run can never create a
// duplicate (Finance repositioning MVP-5, spec acceptance criterion #9).
// Same sanitization pattern as accountCodeRuleDocId in accountCodes.js.
export function operationCenterDocId(kind, ocId) {
  return `oc_${kind === 'po' ? 'po' : 'si'}_${String(ocId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

// Maps one row from costing-tool's finance-po-sync endpoint into the
// purchaseOrders row shape (same fields mapDocumentCsvRecords produces),
// so Invoices.jsx/Reconciliation.jsx need no changes to treat a synced PO
// like a CSV-imported one.
export function mapOperationCenterPoRow(row) {
  return {
    number: row.pu_number || '',
    counterpartyName: row.supplier_name || '',
    counterpartyCode: row.supplier_erp_code || '',
    date: row.issued_date || '',
    amount: Number(row.grandTotal) || 0,
    currency: row.currency || '',
    notes: row.status ? `Operation Center status: ${row.status}` : '',
  }
}

// Maps one row from costing-tool's uc.js list_invoices op into the
// salesInvoices row shape. accounting_total (the bookkeeping-adjusted
// total) is preferred over the raw total when present, same distinction
// uc.js's own upsert_invoice op treats as authoritative.
export function mapOperationCenterInvoiceRow(row) {
  return {
    number: row.si_no || '',
    counterpartyName: row.customer || '',
    counterpartyCode: '',
    date: row.invoice_date || row.invoiced_at || '',
    amount: Number(row.accounting_total ?? row.total) || 0,
    currency: row.currency || '',
    notes: row.remarks || '',
  }
}

// Upload the original source file (CSV or PDF/image) exactly as received,
// for audit trail — same rationale as uploadStatementFile in
// statementStorage.js. Returns { url, path } to store on the record.
export async function uploadDocumentFile(file, projectId, kind, docId) {
  const collectionPath = kind === 'po' ? 'purchaseOrders' : kind === 'income' ? 'income' : 'invoices'
  const ext = file.name.split('.').pop() || 'bin'
  const path = `${collectionPath}/${projectId}/${docId}/source.${ext}`
  const storageRef = ref(storage, path)
  await uploadBytes(storageRef, file, { contentType: file.type || 'application/octet-stream' })
  const url = await getDownloadURL(storageRef)
  return { url, path }
}
