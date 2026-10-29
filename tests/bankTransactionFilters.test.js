import test from 'node:test'
import assert from 'node:assert/strict'
import { accountTypeForTransaction, filterBankTransactionRows } from '../src/lib/bankTransactionFilters.js'

const accounts = [
  { id: 'current', label: 'HSBC Operation 139-498232-001', accountTail: '001', sourceType: 'bank', ledgerType: 'current' },
  { id: 'savings', label: 'HSBC Savings', accountTail: '838', sourceType: 'bank', ledgerType: 'savings' },
  { id: 'legacy', label: 'Old bank account', sourceType: 'bank' },
  { id: 'card', label: 'HSBC card', sourceType: 'credit_card' },
]
const rows = [
  { txn: { id: 'a', paymentAccountId: 'current', transactionDate: '2026-08-01' }, status: 'Unmatched' },
  { txn: { id: 'b', paymentAccountId: 'savings', transactionDate: '2026-09-01' }, status: 'Confirmed' },
  { txn: { id: 'c', paymentAccountId: 'legacy', transactionDate: '2026-10-01', statementSectionKey: 'HKD:savings:legacy' }, status: 'Unmatched' },
  { txn: { id: 'd', paymentAccountId: 'legacy', transactionDate: '2026-10-02' }, status: 'Unmatched' },
  { txn: { id: 'e', paymentAccountId: 'card', transactionDate: '2026-10-03' }, status: 'Unmatched' },
]

test('account type uses the statement section, then account metadata, without guessing legacy banks', () => {
  assert.equal(accountTypeForTransaction(rows[2].txn, accounts[2]), 'savings')
  assert.equal(accountTypeForTransaction(rows[0].txn, accounts[0]), 'current')
  assert.equal(accountTypeForTransaction(rows[3].txn, accounts[2]), 'unspecified')
  assert.equal(accountTypeForTransaction(rows[4].txn, accounts[3]), 'credit_card')
})

test('account search matches a formatted account number, stored ending, or name', () => {
  assert.deepEqual(filterBankTransactionRows(rows, accounts, { accountSearch: '139498232001' }).map(r => r.txn.id), ['a'])
  assert.deepEqual(filterBankTransactionRows(rows, accounts, { accountSearch: '838' }).map(r => r.txn.id), ['b'])
  assert.deepEqual(filterBankTransactionRows(rows, accounts, { accountSearch: 'hsbc card' }).map(r => r.txn.id), ['e'])
})

test('account type and exact account filters combine with existing date filters', () => {
  assert.deepEqual(filterBankTransactionRows(rows, accounts, { accountType: 'savings' }).map(r => r.txn.id), ['c', 'b'])
  assert.deepEqual(filterBankTransactionRows(rows, accounts, { accountType: 'savings', accountId: 'savings' }).map(r => r.txn.id), ['b'])
  assert.deepEqual(filterBankTransactionRows(rows, accounts, { accountType: 'unspecified' }).map(r => r.txn.id), ['d'])
  assert.deepEqual(filterBankTransactionRows(rows, accounts, { accountType: 'savings', from: '2026-10-01' }).map(r => r.txn.id), ['c'])
})
