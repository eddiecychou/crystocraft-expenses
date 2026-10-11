import test from 'node:test'
import assert from 'node:assert/strict'
import { sortStatementImports, filterStatementImports } from '../src/lib/statementImportOrder.js'

test('statements appear newest period first, with new attempts by start time', () => {
  const timestamp = (date, seconds) => ({ toDate: () => new Date(date), seconds })
  const old = { id: 'old', sourceFileName: 'a.pdf', periodEnd: '2025-08-31', createdAt: timestamp('2026-10-11', 3) }
  const recent = { id: 'recent', sourceFileName: 'z.pdf', periodEnd: '2026-09-30', createdAt: timestamp('2026-10-10', 2) }
  const pending = { id: 'pending', sourceFileName: 'b.pdf', createdAt: timestamp('2026-10-11', 4) }
  assert.deepEqual(sortStatementImports([old, recent, pending]).map(item => item.id), ['pending', 'recent', 'old'])
})

test('account and date range filters include overlapping statement periods', () => {
  const imports = [
    { paymentAccountId: 'red', periodStart: '2026-08-16', periodEnd: '2026-09-16' },
    { paymentAccountId: 'one', periodStart: '2026-08-28', periodEnd: '2026-09-18' },
    { paymentAccountId: 'red', periodStart: '2026-06-01', periodEnd: '2026-06-30' },
    { paymentAccountId: 'red', periodStart: null, periodEnd: null },
  ]
  assert.deepEqual(filterStatementImports(imports, 'red', '2026-09-01', '2026-09-30'), [imports[0]])
  assert.deepEqual(filterStatementImports(imports, '', '2026-09-17', ''), [imports[1]])
  assert.deepEqual(filterStatementImports(imports, 'red', '', '2026-07-01'), [imports[2]])
  assert.deepEqual(filterStatementImports(imports, 'red', '', ''), [imports[0], imports[2], imports[3]])
  assert.deepEqual(filterStatementImports(imports, '', '2026-10-01', '2026-09-01'), [])
})
