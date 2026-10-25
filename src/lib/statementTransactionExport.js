export const STATEMENT_EXPORT_COLUMNS = [
  { header: 'Date', key: 'date', width: 14, style: { numFmt: 'yyyy-mm-dd' } },
  { header: 'Value Date', key: 'valueDate', width: 14, style: { numFmt: 'yyyy-mm-dd' } },
  { header: 'Account', key: 'account', width: 25 },
  { header: 'Account Ownership', key: 'ownership', width: 19 },
  { header: 'Source', key: 'source', width: 15 },
  { header: 'Direction', key: 'direction', width: 13 },
  { header: 'Amount', key: 'amount', width: 15, style: { numFmt: '#,##0.00;-#,##0.00' } },
  { header: 'Currency', key: 'currency', width: 11 },
  { header: 'Balance After', key: 'balance', width: 17, style: { numFmt: '#,##0.00;-#,##0.00' } },
  { header: 'Description', key: 'description', width: 45 },
  { header: 'Transaction Type', key: 'type', width: 19 },
  { header: 'Classification', key: 'classification', width: 23 },
  { header: 'Reconciliation Status', key: 'status', width: 24 },
  { header: 'Matched Record', key: 'matchedRecord', width: 37 },
  { header: 'Account Code', key: 'accountCode', width: 19, style: { numFmt: '@' } },
  { header: 'Statement File', key: 'statementFile', width: 36 },
  { header: 'Transaction ID', key: 'transactionId', width: 24, style: { numFmt: '@' } },
]

function excelNumber(value, field, transactionId) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`Invalid ${field} for transaction ${transactionId || 'unknown'}`)
  return number
}

function excelDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value || ''
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : value
}

export function sortStatementRowsByDate(rows, order) {
  return [...rows].sort((a, b) => (order === 'asc' ? 1 : -1) *
    (a.txn.transactionDate || '').localeCompare(b.txn.transactionDate || ''))
}

export function statementExportRow({ txn, matched, status }, account, statement, classificationLabels = {}) {
  const record = matched?.record
  let amount = excelNumber(txn.settlementAmount, 'amount', txn.id)
  if (amount !== null && txn.direction === 'debit') amount = amount === 0 ? 0 : -Math.abs(amount)
  if (amount !== null && txn.direction === 'credit') amount = Math.abs(amount)
  return {
    date: excelDate(txn.transactionDate || txn.rawDateText),
    valueDate: excelDate(txn.postDate),
    account: account?.label || '',
    ownership: account?.ownershipType || 'company',
    source: account?.sourceType || '',
    direction: txn.direction || '',
    amount,
    currency: txn.settlementCurrency || '',
    balance: excelNumber(txn.balanceAfter, 'balance', txn.id),
    description: txn.merchantRaw || '',
    type: txn.transactionType || '',
    classification: classificationLabels[txn.classification] || txn.classification || '',
    status,
    matchedRecord: record ? `${matched.recordType}: ${record.vendor || record.counterpartyName || ''}` : '',
    accountCode: record?.accountCode == null ? '' : String(record.accountCode),
    statementFile: statement?.sourceFileName || '',
    transactionId: txn.id == null ? '' : String(txn.id),
  }
}
