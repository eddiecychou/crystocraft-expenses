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
  invoice: ['invoice no', 'invoice #', 'invoice number', 'inv no', 'inv #', 'number'],
  po: ['po no', 'po #', 'po number', 'purchase order no', 'purchase order number', 'pu no', 'pu #', 'number'],
}
const COUNTERPARTY_ALIASES = {
  invoice: ['customer', 'customer name', 'client', 'bill to', 'counterparty'],
  po: ['supplier', 'supplier name', 'vendor', 'vendor name', 'counterparty'],
}
const DATE_ALIASES = ['date', 'invoice date', 'po date', 'order date', 'issue date']
const AMOUNT_ALIASES = ['amount', 'total', 'invoice amount', 'amount due', 'order total', 'grand total']
const CURRENCY_ALIASES = ['currency', 'curr']
const NOTES_ALIASES = ['notes', 'remarks', 'description', 'memo']

function findColumn(headers, aliases) {
  const lower = headers.map(h => h.toLowerCase())
  for (const alias of aliases) {
    const i = lower.indexOf(alias)
    if (i !== -1) return headers[i]
  }
  return null
}

// Maps parsed CSV records into the salesInvoices/purchaseOrders row shape
// (minus ids/timestamps, which the caller assigns on write). `kind` is
// 'invoice' or 'po' — only the column aliases and output field name for
// the counterparty/number differ between the two.
export function mapDocumentCsvRecords(records, headers, kind) {
  const numberCol = findColumn(headers, NUMBER_ALIASES[kind])
  const counterpartyCol = findColumn(headers, COUNTERPARTY_ALIASES[kind])
  const dateCol = findColumn(headers, DATE_ALIASES)
  const amountCol = findColumn(headers, AMOUNT_ALIASES)
  const currencyCol = findColumn(headers, CURRENCY_ALIASES)
  const notesCol = findColumn(headers, NOTES_ALIASES)

  return records.map((rec, i) => {
    const amountRaw = amountCol ? parseFloat((rec[amountCol] || '').replace(/[,$]/g, '')) : NaN
    return {
      sourceRowIndex: i,
      number: numberCol ? (rec[numberCol] || '').trim() : '',
      counterpartyName: counterpartyCol ? (rec[counterpartyCol] || '').trim() : '',
      date: dateCol ? parseStatementDate(rec[dateCol]) : null,
      amount: isNaN(amountRaw) ? null : amountRaw,
      currency: currencyCol ? (rec[currencyCol] || '').trim().toUpperCase() : 'HKD',
      notes: notesCol ? (rec[notesCol] || '').trim() : '',
    }
  }).filter(r => r.amount != null)
}

// Upload the original source file (CSV or PDF/image) exactly as received,
// for audit trail — same rationale as uploadStatementFile in
// statementStorage.js. Returns { url, path } to store on the record.
export async function uploadDocumentFile(file, projectId, kind, docId) {
  const collectionPath = kind === 'po' ? 'purchaseOrders' : 'invoices'
  const ext = file.name.split('.').pop() || 'bin'
  const path = `${collectionPath}/${projectId}/${docId}/source.${ext}`
  const storageRef = ref(storage, path)
  await uploadBytes(storageRef, file, { contentType: file.type || 'application/octet-stream' })
  const url = await getDownloadURL(storageRef)
  return { url, path }
}
