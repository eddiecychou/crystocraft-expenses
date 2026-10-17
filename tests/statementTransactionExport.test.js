import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { STATEMENT_EXPORT_COLUMNS, statementExportRow } from '../src/lib/statementTransactionExport.js'

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
  assert.equal(restored.getWorksheet(1).getCell('G2').value, 0)
  assert.equal(restored.getWorksheet(1).getCell('J2').value, '=HYPERLINK("https://example.test","Test payment")')
  assert.equal(restored.getWorksheet(1).getCell('P2').value, 'October.pdf')
})
