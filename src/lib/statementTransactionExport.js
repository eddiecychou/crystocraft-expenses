export const STATEMENT_EXPORT_COLUMNS = [
  { header: 'Date', key: 'date', width: 14 },
  { header: 'Value Date', key: 'valueDate', width: 14 },
  { header: 'Account', key: 'account', width: 25 },
  { header: 'Account Ownership', key: 'ownership', width: 19 },
  { header: 'Source', key: 'source', width: 15 },
  { header: 'Direction', key: 'direction', width: 13 },
  { header: 'Amount', key: 'amount', width: 15 },
  { header: 'Currency', key: 'currency', width: 11 },
  { header: 'Balance After', key: 'balance', width: 17 },
  { header: 'Description', key: 'description', width: 45 },
  { header: 'Transaction Type', key: 'type', width: 19 },
  { header: 'Classification', key: 'classification', width: 23 },
  { header: 'Reconciliation Status', key: 'status', width: 24 },
  { header: 'Matched Record', key: 'matchedRecord', width: 37 },
  { header: 'Account Code', key: 'accountCode', width: 19 },
  { header: 'Statement File', key: 'statementFile', width: 36 },
  { header: 'Transaction ID', key: 'transactionId', width: 24 },
]

export function statementExportRow({ txn, matched, status }, account, statement, classificationLabels = {}) {
  const record = matched?.record
  return {
    date: txn.transactionDate || txn.rawDateText || '',
    valueDate: txn.postDate || '',
    account: account?.label || '',
    ownership: account?.ownershipType || 'company',
    source: account?.sourceType || '',
    direction: txn.direction || '',
    amount: txn.settlementAmount == null ? null : Number(txn.settlementAmount),
    currency: txn.settlementCurrency || '',
    balance: txn.balanceAfter == null ? null : Number(txn.balanceAfter),
    description: txn.merchantRaw || '',
    type: txn.transactionType || '',
    classification: classificationLabels[txn.classification] || txn.classification || '',
    status,
    matchedRecord: record ? `${matched.recordType}: ${record.vendor || record.counterpartyName || ''}` : '',
    accountCode: record?.accountCode || '',
    statementFile: statement?.sourceFileName || '',
    transactionId: txn.id,
  }
}
