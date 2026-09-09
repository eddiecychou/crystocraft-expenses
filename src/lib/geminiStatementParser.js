// Client-side call to the tier-3 statement-parsing fallback
// (process-statement-text.js) — only invoked by pdfStatementParser.js when
// its own column-position parser and single-line fallback both find zero
// rows in a statement that does have real extracted text. See
// process-statement-text.js's header comment for why this exists and why
// it's still checked, not trusted, downstream.
import { auth } from '../firebase'

// Returns rows in the same shape parseSection/parseFallback in
// pdfStatementParser.js already produce, minus geometry fields
// (pageNumber/maskRect) this text-only path has no PDF coordinates for —
// callers already tolerate a missing maskRect (see CompanyReview.jsx's
// `rows.every(r => r.maskRect)` guard before attempting redaction).
export async function parseStatementRowsWithGemini(text) {
  const idToken = await auth.currentUser.getIdToken()
  const res = await fetch('/api/process-statement-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, idToken }),
  })
  const data = await res.json()
  if (!res.ok || !Array.isArray(data.rows)) return []

  return data.rows
    .filter(r => r && r.date && r.amount != null && r.direction)
    .map((r, i) => ({
      sourceRowIndex: i,
      rawRowText: r.description || '',
      rawDateText: r.date,
      transactionDate: r.date,
      postDate: null,
      merchantRaw: (r.description || '').trim(),
      settlementAmount: Math.abs(Number(r.amount)) || 0,
      direction: r.direction === 'credit' ? 'credit' : 'debit',
      balanceAfter: r.balanceAfter != null ? Number(r.balanceAfter) : null,
      installmentIndicator: false,
      installmentNumber: null,
      installmentTotal: null,
      maskRect: null,
      extractionMethod: 'ai_assisted',
    }))
    .filter(r => r.settlementAmount > 0)
}
