function sourceHasAmount(text, amount) {
  return (text.match(/\(?-?[\d,]+\.\d{2}\)?/g) || [])
    .some(value => Math.abs(Math.abs(Number(value.replace(/[(),]/g, ''))) - amount) <= 0.01)
}

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value
}

// The model cites the printed line containing each proposed transaction
// amount. Reject rows without that evidence; flag other ungrounded fields.
export function mapGeminiStatementRows(candidates, page, pageNumber) {
  const rows = []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const sourceLine = Number(String(candidate.sourceLine).replace(/^L/i, ''))
    const amount = Math.abs(Number(candidate.amount))
    const source = page.lines[sourceLine - 1]
    if (!source || !Number.isFinite(amount) || amount <= 0 || !sourceHasAmount(source.text, amount)) continue
    if (!validIsoDate(candidate.date) || typeof candidate.description !== 'string' || !candidate.description.trim()) continue
    if (!['debit', 'credit'].includes(candidate.direction)) continue
    const sourceSpan = page.lines.slice(Math.max(0, sourceLine - 3), sourceLine).map(line => line.text).join(' ').toLowerCase()
    const descriptionGrounded = candidate.description.toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter(token => token.length >= 3).some(token => sourceSpan.includes(token))
    const balance = candidate.balanceAfter == null ? null : Number(candidate.balanceAfter)
    const balanceGrounded = balance == null || (Number.isFinite(balance) && sourceHasAmount(source.text, Math.abs(balance)))
    rows.push({
      sourceRowIndex: rows.length,
      pageNumber,
      rawRowText: source.text,
      rawDateText: candidate.date,
      transactionDate: candidate.date,
      postDate: null,
      merchantRaw: candidate.description.trim(),
      settlementAmount: amount,
      direction: candidate.direction,
      balanceAfter: balanceGrounded ? balance : null,
      installmentIndicator: false,
      installmentNumber: null,
      installmentTotal: null,
      maskRect: null,
      extractionMethod: 'ai_assisted',
      evidenceWarning: !descriptionGrounded || !balanceGrounded,
    })
  }
  return rows
}
