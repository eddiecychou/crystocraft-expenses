import { sortStatementRowsByDate } from './statementTransactionExport.js'

const ACCOUNT_TYPES = new Set(['current', 'savings', 'credit_card'])

function normalizeAccountSearch(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]/g, '')
}

export function accountTypeForTransaction(txn, account) {
  const sectionType = txn.statementSectionKey?.split(':')[1]
  if (ACCOUNT_TYPES.has(sectionType)) return sectionType
  if (ACCOUNT_TYPES.has(account?.ledgerType)) return account.ledgerType
  return account?.sourceType === 'credit_card' ? 'credit_card' : 'unspecified'
}

export function filterBankTransactionRows(rows, accounts, filters = {}) {
  const { from = '', to = '', accountId = 'all', accountSearch = '', accountType = 'all',
    direction = 'all', status = 'all', source = 'all', dateOrder = 'desc' } = filters
  const byId = new Map(accounts.map(account => [account.id, account]))
  const search = normalizeAccountSearch(accountSearch)

  return sortStatementRowsByDate(rows.filter(({ txn, status: rowStatus }) => {
    const account = byId.get(txn.paymentAccountId)
    if (from && (txn.transactionDate || '') < from) return false
    if (to && (txn.transactionDate || '') > to) return false
    if (accountId !== 'all' && txn.paymentAccountId !== accountId) return false
    if (search && ![account?.label, account?.accountTail, account?.institutionName]
      .some(value => normalizeAccountSearch(value).includes(search))) return false
    if (accountType !== 'all' && accountTypeForTransaction(txn, account) !== accountType) return false
    if (direction !== 'all' && txn.direction !== direction) return false
    if (status !== 'all' && rowStatus !== status) return false
    if (source !== 'all' && account?.sourceType !== source) return false
    return true
  }), dateOrder)
}
