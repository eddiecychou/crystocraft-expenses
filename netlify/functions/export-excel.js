import ExcelJS from 'exceljs'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY
  const PROJECT_ID = process.env.FIREBASE_PROJECT_ID

  try {
    const { idToken } = JSON.parse(event.body)

    // Verify token and get userId
    const verRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    )
    const verData = await verRes.json()
    if (!verRes.ok || !verData.users?.[0]) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }
    }
    const userId = verData.users[0].localId

    // Query Firestore via REST API using the user's own token
    const qRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'expenses' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'userId' },
                op: 'EQUAL',
                value: { stringValue: userId },
              },
            },
            orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
          },
        }),
      }
    )
    const rows = await qRes.json()

    const expenses = rows
      .filter(r => r.document)
      .map(r => {
        const f = r.document.fields
        return {
          date: f.date?.stringValue || '',
          vendor: f.vendor?.stringValue || '',
          amount: parseFloat(f.amount?.doubleValue ?? f.amount?.integerValue ?? 0),
          currency: f.currency?.stringValue || 'HKD',
          category: f.category?.stringValue || '',
          notes: f.notes?.stringValue || '',
          uploadedBy: f.userEmail?.stringValue || '',
        }
      })

    // Build Excel workbook
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Expenses')

    ws.columns = [
      { header: 'Date',        key: 'date',       width: 14 },
      { header: 'Vendor',      key: 'vendor',     width: 26 },
      { header: 'Amount',      key: 'amount',     width: 12 },
      { header: 'Currency',    key: 'currency',   width: 10 },
      { header: 'Category',    key: 'category',   width: 16 },
      { header: 'Notes',       key: 'notes',      width: 32 },
      { header: 'Uploaded By', key: 'uploadedBy', width: 26 },
    ]

    const headerRow = ws.getRow(1)
    headerRow.font = { bold: true }
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } }

    expenses.forEach(e => ws.addRow(e))

    if (expenses.length > 0) {
      ws.addRow({})
      const total = expenses.reduce((s, e) => s + e.amount, 0)
      const totalRow = ws.addRow({ date: 'TOTAL', amount: total })
      totalRow.font = { bold: true }
      ws.getCell(`C${totalRow.number}`).numFmt = '#,##0.00'
    }

    const buffer = await wb.xlsx.writeBuffer()

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="expenses-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      },
      body: Buffer.from(buffer).toString('base64'),
      isBase64Encoded: true,
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
