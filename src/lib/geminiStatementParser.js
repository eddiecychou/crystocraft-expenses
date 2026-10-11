import { auth } from '../firebase'
import { mapGeminiStatementRows } from './statementAiEvidence'

const STATEMENT_AI_TIMEOUT_MS = 30000
const MAX_CHUNK_CHARS = 9000

function chunksForPage(lines) {
  const chunks = []
  let chunk = []
  let length = 0
  lines.forEach((line, index) => {
    const printed = `L${index + 1} ${line.items.map(item => `[${Math.round(item.x)}]${item.text}`).join(' ')}\n`
    if ((length + printed.length > MAX_CHUNK_CHARS || chunk.length >= 25) && chunk.length) {
      chunks.push(chunk)
      chunk = []
      length = 0
    }
    chunk.push(printed)
    length += printed.length
  })
  if (chunk.length) chunks.push(chunk)
  return chunks
}

async function requestRows(text) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STATEMENT_AI_TIMEOUT_MS)
  let response
  try {
    response = await fetch('/api/process-statement-text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, idToken: await auth.currentUser.getIdToken() }),
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('AI reading timed out after 30 seconds')
    throw err
  } finally {
    clearTimeout(timer)
  }
  const data = await response.json()
  if (!response.ok || !Array.isArray(data.rows)) throw new Error(data.error || 'AI could not read this page')
  return data.rows
}

// Each model row must point back to the printed line containing its amount.
// This catches invented numbers without relying on the model's own confidence.
export async function parseStatementRowsWithGemini(page, pageNumber, anchorDate, onChunkProgress) {
  const rows = []
  const chunks = chunksForPage(page.lines)
  const header = page.lines.find(line => /date/i.test(line.text) && /debit|credit|amount|withdrawal|deposit/i.test(line.text))?.text || ''
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    onChunkProgress?.(index + 1, chunks.length)
    const candidates = await requestRows(`Statement date/period context: ${anchorDate || 'not found'}\nColumn header for context only: ${header}\n${chunk.join('')}`)
    const permittedLines = new Set(chunk.map(line => Number(line.match(/^L(\d+)/)?.[1])))
    rows.push(...mapGeminiStatementRows(candidates.filter(candidate => permittedLines.has(Number(String(candidate?.sourceLine).replace(/^L/i, '')))), page, pageNumber))
  }
  return rows
}
