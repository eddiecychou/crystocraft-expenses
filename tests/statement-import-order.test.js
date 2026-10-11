import test from 'node:test'
import assert from 'node:assert/strict'
import { sortStatementImports } from '../src/lib/statementImportOrder.js'

test('statements appear newest period first, with new attempts by start time', () => {
  const timestamp = (date, seconds) => ({ toDate: () => new Date(date), seconds })
  const old = { id: 'old', sourceFileName: 'a.pdf', periodEnd: '2025-08-31', createdAt: timestamp('2026-10-11', 3) }
  const recent = { id: 'recent', sourceFileName: 'z.pdf', periodEnd: '2026-09-30', createdAt: timestamp('2026-10-10', 2) }
  const pending = { id: 'pending', sourceFileName: 'b.pdf', createdAt: timestamp('2026-10-11', 4) }
  assert.deepEqual(sortStatementImports([old, recent, pending]).map(item => item.id), ['pending', 'recent', 'old'])
})
