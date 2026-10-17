import test from 'node:test'
import assert from 'node:assert/strict'
import { findStatementAnchorDate } from '../src/lib/statementDateAnchor.js'

test('skips HSBC address and uses the printed March 2025 statement date', () => {
  const text = '38 UNIT 1905 19/F HSBC BUSINESS DIRECT 21 March 2025 5 Mar MONTHLY SERVICE FEE'
  assert.equal(findStatementAnchorDate(text)?.toISOString().slice(0, 10), '2025-03-21')
})

test('finds July 2025 after the same misleading address', () => {
  const text = '38 UNIT 1905 19/F HSBC BUSINESS DIRECT 21 July 2025 5 Jul MONTHLY SERVICE FEE'
  assert.equal(findStatementAnchorDate(text)?.toISOString().slice(0, 10), '2025-07-21')
})

test('rejects invalid calendar dates and never guesses the current year', () => {
  assert.equal(findStatementAnchorDate('31 FEB 2025 17 AUG 2026')?.toISOString().slice(0, 10), '2026-08-17')
  assert.equal(findStatementAnchorDate('38 UNIT 1905 5 Mar monthly fee'), null)
})
