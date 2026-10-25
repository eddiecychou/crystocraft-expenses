import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { STATEMENT_EXPORT_COLUMNS, sortStatementRowsByDate, statementExportRow } from '../src/lib/statementTransactionExport.js'

test('exports statement row details without source-file access tokens', async () => {
  const row = statementExportRow({
    txn: {
      id: 'txn-1', transactionDate: '2026-10-01', postDate: '2026-10-02',
      direction: 'debit', settlementAmount: 0, settlementCurrency: 'HKD', balanceAfter: 100,
      merchantRaw: '=HYPERLINK("https://example.test","Test payment")', transactionType: 'payment', classification: 'company',
    },
    matched: { recordType: 'expense', record: { vendor: 'Vendor', accountCode: 'A0001' } },
    status: 'Confirmed',
  }, { label: 'HSBC', ownershipType: 'personal', sourceType: 'bank' }, {
    sourceFileName: 'October.pdf', sourceFileUrl: 'https://private.example/?token=secret',
  })

  assert.equal(row.amount, 0)
  assert.equal(row.date.toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(row.valueDate.toISOString(), '2026-10-02T00:00:00.000Z')
  assert.equal(row.balance, 100)
  assert.equal(row.ownership, 'personal')
  assert.equal(row.statementFile, 'October.pdf')
  assert.equal(row.status, 'Confirmed')
  assert.equal(JSON.stringify(row).includes('secret'), false)

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Statement Transactions')
  sheet.columns = STATEMENT_EXPORT_COLUMNS
  sheet.addRow(row)
  const restored = new ExcelJS.Workbook()
  await restored.xlsx.load(await workbook.xlsx.writeBuffer())
  assert.equal(restored.getWorksheet(1).getCell('A2').value.toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(restored.getWorksheet(1).getCell('A2').numFmt, 'yyyy-mm-dd')
  assert.equal(restored.getWorksheet(1).getCell('B2').value.toISOString(), '2026-10-02T00:00:00.000Z')
  assert.equal(restored.getWorksheet(1).getCell('B2').numFmt, 'yyyy-mm-dd')
  assert.equal(restored.getWorksheet(1).getCell('G2').value, 0)
  assert.equal(restored.getWorksheet(1).getCell('G2').numFmt, '#,##0.00;-#,##0.00')
  assert.equal(restored.getWorksheet(1).getCell('I2').value, 100)
  assert.equal(restored.getWorksheet(1).getCell('I2').numFmt, '#,##0.00;-#,##0.00')
  assert.equal(restored.getWorksheet(1).getCell('J2').value, '=HYPERLINK("https://example.test","Test payment")')
  assert.equal(restored.getWorksheet(1).getCell('O2').value, 'A0001')
  assert.equal(restored.getWorksheet(1).getCell('O2').numFmt, '@')
  assert.equal(restored.getWorksheet(1).getCell('P2').value, 'October.pdf')
  assert.equal(restored.getWorksheet(1).getCell('Q2').value, 'txn-1')
  assert.equal(restored.getWorksheet(1).getCell('Q2').numFmt, '@')
})

test('all export columns retain the intended Excel value types', async () => {
  const row = statementExportRow({
    txn: {
      id: '00042', transactionDate: '2026-10-01', postDate: '2026-10-02',
      direction: 'credit', settlementAmount: 12.34, settlementCurrency: 'HKD', balanceAfter: -1234.5,
      merchantRaw: 'Payer', transactionType: 'deposit', classification: 'company',
    },
    matched: { recordType: 'income', record: { counterpartyName: 'Payer', accountCode: '00123' } },
    status: 'Confirmed',
  }, { label: 'HSBC', ownershipType: 'company', sourceType: 'bank' }, { sourceFileName: 'October.pdf' }, { company: 'Company' })
  assert.deepEqual(Object.keys(row), STATEMENT_EXPORT_COLUMNS.map(column => column.key))

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Statement Transactions')
  sheet.columns = STATEMENT_EXPORT_COLUMNS
  sheet.addRow(row)
  const restored = new ExcelJS.Workbook()
  await restored.xlsx.load(await workbook.xlsx.writeBuffer())
  const cells = restored.getWorksheet(1).getRow(2)
  for (let column = 1; column <= STATEMENT_EXPORT_COLUMNS.length; column++) {
    const value = cells.getCell(column).value
    if (column <= 2) assert.ok(value instanceof Date, STATEMENT_EXPORT_COLUMNS[column - 1].header)
    else if (column === 7 || column === 9) assert.equal(typeof value, 'number', STATEMENT_EXPORT_COLUMNS[column - 1].header)
    else assert.equal(typeof value, 'string', STATEMENT_EXPORT_COLUMNS[column - 1].header)
  }
  assert.equal(cells.getCell('I').value, -1234.5)
  assert.equal(cells.getCell('O').value, '00123')
  assert.equal(cells.getCell('Q').value, '00042')
})

test('exports debits as negative and credits as positive numeric amounts', async () => {
  const transactions = [
    { id: 'debit', transactionDate: '2026-10-02', direction: 'debit', settlementAmount: 125.5 },
    { id: 'credit', transactionDate: '2026-10-01', direction: 'credit', settlementAmount: -80.25 },
    { id: 'zero', transactionDate: '2026-10-03', direction: 'debit', settlementAmount: 0 },
  ]
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Statement Transactions')
  sheet.columns = STATEMENT_EXPORT_COLUMNS
  for (const txn of transactions) sheet.addRow(statementExportRow({ txn }, null, null))
  const restored = new ExcelJS.Workbook()
  await restored.xlsx.load(await workbook.xlsx.writeBuffer())
  assert.deepEqual([2, 3, 4].map(row => restored.getWorksheet(1).getCell(`G${row}`).value), [-125.5, 80.25, 0])
  assert.equal(typeof restored.getWorksheet(1).getCell('G2').value, 'number')
})

test('date order changes the worksheet row order without changing the input', async () => {
  const rows = ['2026-10-02', '2026-10-01', '2026-10-03'].map((transactionDate, index) => ({
    txn: { id: `txn-${index}`, transactionDate, direction: 'credit', settlementAmount: index + 1 },
  }))
  assert.deepEqual(sortStatementRowsByDate(rows, 'asc').map(row => row.txn.transactionDate), ['2026-10-01', '2026-10-02', '2026-10-03'])
  const descending = sortStatementRowsByDate(rows, 'desc')
  assert.deepEqual(descending.map(row => row.txn.transactionDate), ['2026-10-03', '2026-10-02', '2026-10-01'])
  assert.deepEqual(rows.map(row => row.txn.transactionDate), ['2026-10-02', '2026-10-01', '2026-10-03'])

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Statement Transactions')
  sheet.columns = STATEMENT_EXPORT_COLUMNS
  descending.forEach(row => sheet.addRow(statementExportRow(row, null, null)))
  const restored = new ExcelJS.Workbook()
  await restored.xlsx.load(await workbook.xlsx.writeBuffer())
  assert.deepEqual([2, 3, 4].map(row => restored.getWorksheet(1).getCell(`A${row}`).value.toISOString().slice(0, 10)),
    ['2026-10-03', '2026-10-02', '2026-10-01'])
})

test('unrecognized dates remain text rather than incorrect Excel dates', () => {
  const row = statementExportRow({ txn: { transactionDate: '2026-02-30', postDate: '01/03/26' } }, null, null)
  assert.equal(row.date, '2026-02-30')
  assert.equal(row.valueDate, '01/03/26')
})

test('missing financial values remain blank and invalid values are not silently exported', () => {
  const missing = statementExportRow({ txn: { id: 'missing', settlementAmount: '', balanceAfter: null } }, null, null)
  assert.equal(missing.amount, null)
  assert.equal(missing.balance, null)
  assert.equal(statementExportRow({ txn: { id: 'blank-balance', settlementAmount: 0, balanceAfter: ' ' } }, null, null).balance, null)
  assert.throws(() => statementExportRow({ txn: { id: 'bad-amount', settlementAmount: 'not a number' } }, null, null),
    /Invalid amount for transaction bad-amount/)
  assert.throws(() => statementExportRow({ txn: { id: 'bad-balance', settlementAmount: 10, balanceAfter: 'not a number' } }, null, null),
    /Invalid balance for transaction bad-balance/)
})
