import test from 'node:test'
import assert from 'node:assert/strict'
import { accountHeading, annotateAccountSections, checkAccountSections, compareSavedAccountSections, validateSectionLayout, validateSectionMappings } from '../src/lib/statementAccountSections.js'

const current = { key: 'current', label: 'HKD Current', currency: 'HKD', accountType: 'current', openingBalance: 44746, closingBalance: 41386 }
const savings = { key: 'savings', label: 'HKD Savings', currency: 'HKD', accountType: 'savings', openingBalance: -5, closingBalance: 0 }
const rows = [
  { sourceRowIndex: 0, sectionKey: 'current', transactionDate: '2025-01-27', merchantRaw: 'Transfer to savings', settlementAmount: 5, direction: 'debit', balanceAfter: 44741 },
  { sourceRowIndex: 1, sectionKey: 'current', transactionDate: '2025-02-05', merchantRaw: 'Fee', settlementAmount: 3355, direction: 'debit', balanceAfter: null },
  { sourceRowIndex: 2, sectionKey: 'savings', transactionDate: '2025-01-27', merchantRaw: 'Transfer from current', settlementAmount: 5, direction: 'credit', balanceAfter: 0 },
]

test('activity headings identify currency and ledger, not portfolio summary values', () => {
  assert.deepEqual(accountHeading('HSBC Business Direct HKD Savings'), {
    key: 'HKD:savings:hsbc business direct hkd savings', label: 'HSBC Business Direct HKD Savings', currency: 'HKD', accountType: 'savings', supportedCurrency: true,
  })
  assert.equal(accountHeading('HKD Savings 582-647889-838 HKD 0.00'), null)
  assert.equal(accountHeading('Account Activities'), null)
  assert.equal(accountHeading('USD Current Account')?.currency, 'USD')
  assert.equal(accountHeading('THB Savings')?.supportedCurrency, false)
  assert.equal(accountHeading('Foreign Currency Savings Account')?.supportedCurrency, false)
  assert.match(validateSectionLayout([accountHeading('Foreign Currency Savings Account')]), /unknown or unsupported/i)
})

test('balances are checked per account and a missing intermediate balance is not a false discrepancy', () => {
  const checks = checkAccountSections([current, savings], rows)
  assert.equal(checks[1].totalsCheck.consistent, true)
  assert.equal(annotateAccountSections(rows)[1].balanceSequenceValid, null)
  assert.equal(annotateAccountSections(rows)[2].balanceSequenceValid, null)
})

test('every account section needs a distinct, same-currency account with safe ownership', () => {
  const accounts = [
    { id: 'c', sourceType: 'bank', settlementCurrency: 'HKD', ownershipType: 'company' },
    { id: 's', sourceType: 'bank', settlementCurrency: 'HKD', ownershipType: 'company', ledgerType: 'savings' },
    { id: 'p', sourceType: 'bank', settlementCurrency: 'HKD', ownershipType: 'personal' },
    { id: 'u', sourceType: 'bank', settlementCurrency: 'USD', ownershipType: 'company' },
  ]
  assert.equal(validateSectionMappings([current, savings], { current: 'c', savings: 's' }, accounts), null)
  assert.match(validateSectionMappings([current, savings], { current: 'c' }, accounts), /every section/i)
  assert.match(validateSectionMappings([current, savings], { current: 'c', savings: 'c' }, accounts), /own account/i)
  assert.match(validateSectionMappings([current, savings], { current: 'c', savings: 'u' }, accounts), /currency/i)
  assert.match(validateSectionMappings([current, savings], { current: 'c', savings: 'p' }, accounts), /personal accounts/i)
  assert.match(validateSectionMappings([accountHeading('THB Savings')], {}, accounts), /unsupported currency/i)
})

test('re-check rejects a right row saved under the wrong account', () => {
  const sections = [current, savings]
  const savedSections = sections.map(section => ({ ...section, paymentAccountId: section.key }))
  const stored = rows.map(row => ({ ...row, statementSectionKey: row.sectionKey, paymentAccountId: row.sectionKey, settlementCurrency: 'HKD' }))
  const good = compareSavedAccountSections(sections, rows, stored, savedSections)
  assert.equal(good.mappingMatches, true)
  assert.equal(good.missingFromRecords, 0)
  const misplaced = stored.map(row => row.statementSectionKey === 'savings' ? { ...row, paymentAccountId: 'current' } : row)
  const bad = compareSavedAccountSections(sections, rows, misplaced, savedSections)
  assert.equal(bad.mappingMatches, false)
  assert.equal(bad.consistent, false)
})
