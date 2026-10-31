import test from 'node:test'
import assert from 'node:assert/strict'
import { suggestTransactionPrefix, validateTransactionPrefix, transactionNumber, assignImportNumbers, preserveReprocessedNumbers, sortRowsForNumbering } from '../src/lib/transactionNumbering.js'

test('suggests a project/account prefix without exposing a full account number', () => {
  const details = { projectName: 'Cankleen', institutionName: 'HSBC', label: 'Business Savings 123456789', accountTail: '6789', ledgerType: 'savings' }
  assert.equal(suggestTransactionPrefix(details), 'CAN-HSBC-SAV-6789')
  assert.equal(suggestTransactionPrefix(details, [{ id: 'one', transactionPrefix: 'CAN-HSBC-SAV-6789' }]), 'CAN-HSBC-SAV-6789-2')
  assert.equal(validateTransactionPrefix('CAN-HSBC-SAV-6789', [{ id: 'one', transactionPrefix: 'CAN-HSBC-SAV-6789' }]), 'Another account in this project already uses that prefix.')
  assert.equal(transactionNumber('CAN-HSBC-SAV-6789', 1), 'CAN-HSBC-SAV-6789-000001')
})

test('reprocess preserves numbered rows across an inserted row and refuses changed evidence', () => {
  const old = [{ id: 'existing', rawRowText: 'Coffee 20.00', transactionDate: '2025-02-02', settlementAmount: 20, direction: 'debit', balanceAfter: 80, sourceRowIndex: 0, transactionNumber: 'CAN-CUR-000001', transactionSequence: 1 }]
  const newer = [{ rawRowText: 'New row', sourceRowIndex: 0 }, { rawRowText: 'Coffee 20.00', transactionDate: '2025-02-02', settlementAmount: 20, direction: 'debit', balanceAfter: 80, sourceRowIndex: 1 }]
  assert.deepEqual([...preserveReprocessedNumbers(old, newer)], [[1, { id: 'existing', transactionNumber: 'CAN-CUR-000001', transactionSequence: 1 }]])
  assert.throws(() => preserveReprocessedNumbers(old, [{ ...newer[1], rawRowText: 'Different row' }]), /numbered row changed/)
})

test('historical numbering order uses date and printed row order', () => {
  const rows = [{ id: 'b', transactionDate: '2025-02-02', importId: 'i', sourceRowIndex: 1 }, { id: 'a', transactionDate: '2025-02-02', importId: 'i', sourceRowIndex: 0 }]
  assert.deepEqual(sortRowsForNumbering(rows, [{ id: 'i', periodStart: '2025-02-01' }]).map(row => row.id), ['a', 'b'])
})

test('one import chunk gives each account its own continuous sequence and leaves preserved rows unchanged', () => {
  const input = [
    { ref: 'a', data: { importId: 'i', paymentAccountId: 'current' } },
    { ref: 'expense', data: { sourceTransactionId: 'a' } },
    { ref: 'b', data: { importId: 'i', paymentAccountId: 'savings' } },
    { ref: 'old', data: { importId: 'i', paymentAccountId: 'current', transactionNumber: 'CAN-CUR-000001', transactionSequence: 1 } },
    { ref: 'c', data: { importId: 'i', paymentAccountId: 'current' } },
  ]
  const { writes, next } = assignImportNumbers(input, new Map([
    ['current', { prefix: 'CAN-CUR', sequence: 3 }],
    ['savings', { prefix: 'CAN-SAV', sequence: 8 }],
  ]))
  assert.deepEqual(writes.map(item => item.data.transactionNumber || null), ['CAN-CUR-000004', null, 'CAN-SAV-000009', 'CAN-CUR-000001', 'CAN-CUR-000005'])
  assert.equal(next.get('current').sequence, 5)
  assert.equal(next.get('savings').sequence, 9)
})
