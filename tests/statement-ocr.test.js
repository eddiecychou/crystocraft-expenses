import test from 'node:test'
import assert from 'node:assert/strict'
import { wordsToStatementLines } from '../src/lib/statementOcrGeometry.js'
import { mapGeminiStatementRows } from '../src/lib/statementAiEvidence.js'
import ocrHandler from '../netlify/edge-functions/ocr-statement-page.js'

test('OCR words keep page order and column positions in PDF points', () => {
  const lines = wordsToStatementLines([
    { text: '100.00', x: 800, y: 200 },
    { text: '03', x: 80, y: 200 },
    { text: 'Sep', x: 110, y: 202 },
    { text: 'Balance', x: 80, y: 150 },
  ], 500, 700, 1000, 1400)
  assert.deepEqual(lines.map(line => line.text), ['Balance', '03 Sep 100.00'])
  assert.equal(lines[1].items[0].x, 40)
  assert.equal(lines[1].items[2].x, 400)
  assert.ok(lines[0].y > lines[1].y)
})

test('OCR endpoint checks sign-in and returns Vision word boxes without source images', async () => {
  const priorDeno = globalThis.Deno
  const priorFetch = globalThis.fetch
  globalThis.Deno = { env: { get: name => ({ GOOGLE_VISION_API_KEY: 'vision-key', VITE_FIREBASE_API_KEY: 'firebase-key' })[name] } }
  globalThis.fetch = async url => {
    if (url.includes('identitytoolkit')) return new Response(JSON.stringify({ users: [{ localId: 'uid' }] }), { status: 200 })
    return new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { pages: [{ blocks: [{ paragraphs: [{ words: [{
      symbols: [{ text: 'A' }, { text: 'B' }],
      boundingBox: { vertices: [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }, { x: 10, y: 40 }] },
    }] }] }] }] } }] }), { status: 200 })
  }
  try {
    const unsigned = await ocrHandler(new Request('http://localhost/api/ocr-statement-page', {
      method: 'POST', body: JSON.stringify({ image: 'aGVsbG8=' }),
    }))
    assert.equal(unsigned.status, 401)
    const signed = await ocrHandler(new Request('http://localhost/api/ocr-statement-page', {
      method: 'POST', body: JSON.stringify({ image: 'aGVsbG8=', idToken: 'token' }),
    }))
    assert.equal(signed.status, 200)
    assert.deepEqual(await signed.json(), { words: [{ text: 'AB', x: 10, y: 30 }] })
  } finally {
    globalThis.Deno = priorDeno
    globalThis.fetch = priorFetch
  }
})

test('AI rows require a printed amount and flag ungrounded text', () => {
  const page = { lines: [
    { text: '03 Sep COFFEE SHOP 12.50 987.50' },
    { text: '04 Sep GROCER 22.00 965.50' },
  ] }
  const candidates = [
    { sourceLine: 'L1', date: '2026-09-03', description: 'COFFEE SHOP', amount: 12.5, direction: 'debit', balanceAfter: 987.5 },
    { sourceLine: 2, date: '2026-09-04', description: 'Invented vendor', amount: 22, direction: 'debit', balanceAfter: 123.45 },
    { sourceLine: 1, date: '2026-09-03', description: 'COFFEE SHOP', amount: 999, direction: 'debit', balanceAfter: null },
    { sourceLine: 1, date: '2026-99-99', description: 'COFFEE SHOP', amount: 12.5, direction: 'debit', balanceAfter: null },
  ]
  const rows = mapGeminiStatementRows(candidates, page, 2)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].pageNumber, 2)
  assert.equal(rows[0].balanceAfter, 987.5)
  assert.equal(rows[0].evidenceWarning, false)
  assert.equal(rows[1].balanceAfter, null)
  assert.equal(rows[1].evidenceWarning, true)
})
