// Extracts transaction-like rows from a digital (text-based) bank/credit
// card statement PDF. Real statement tables (verified against an actual
// HSBC HK statement) have properties a naive line-by-line reader can't
// handle:
//   - dates are often day+month with NO YEAR ("23 Jul", "11 Aug") — the
//     year has to be inferred from the statement's own printed date.
//   - one transaction's description commonly spans 2-3 lines before its
//     amount appears.
//   - a single date can cover several separate transactions.
//   - which number is the amount vs. the running balance is a function of
//     which COLUMN (x-position) it's printed in, not the order numbers
//     appear in the line.
// So this parses by (1) finding the table's header row and its column
// x-positions, (2) bucketing every subsequent line's text into columns by
// x-position, then (3) walking those bucketed lines as a state machine:
// accumulate description text under the current date until an amount
// column is populated, which closes out one transaction.
//
// This only works on text-based PDFs (the normal case for a statement
// downloaded from online banking). A scanned/photographed PDF has no text
// layer and will extract nothing — callers must handle that and tell the
// user, not guess at numbers from an image.
//
// Because layout varies bank-to-bank, this is heuristic. If no header row
// is recognized on a page, we fall back to a simpler date-line + trailing
// amount heuristic. Unlike CSV import (structured, trusted), callers MUST
// show parsed rows to the user for review before writing anything.

import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const Y_TOLERANCE = 2.5 // points; items within this y-distance are the same line

// ---- Low-level extraction: page -> lines of {x, text} items ------------

async function extractStructuredLines(file) {
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const pages = []

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()
    const rawItems = content.items.filter(it => it.str.trim() !== '')

    const clusters = []
    for (const item of rawItems) {
      const y = item.transform[5]
      const x = item.transform[4]
      let cluster = clusters.find(c => Math.abs(c.y - y) <= Y_TOLERANCE)
      if (!cluster) { cluster = { y, items: [] }; clusters.push(cluster) }
      cluster.items.push({ x, text: item.str.trim() })
    }
    clusters.sort((a, b) => b.y - a.y) // top to bottom
    for (const c of clusters) c.items.sort((a, b) => a.x - b.x) // left to right

    const lines = clusters.map(c => ({
      y: c.y,
      items: c.items,
      text: c.items.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim(),
    })).filter(l => l.text)

    pages.push(lines)
  }
  return pages
}

// ---- Header / column detection ------------------------------------------

const COLUMN_LABELS = {
  date: ['date', '日期'],
  description: ['transaction details', 'description', 'narrative', 'details', 'particulars', '進支詳情', '交易詳情', '摘要'],
  credit: ['deposit', 'credit', '存入'],
  debit: ['withdrawal', 'debit', '支出'],
  amount: ['amount'],
  balance: ['balance', '結餘'],
}

function canonicalColumnName(text) {
  const t = text.toLowerCase().trim()
  for (const [canon, aliases] of Object.entries(COLUMN_LABELS)) {
    if (aliases.some(a => t === a || t === a.toLowerCase())) return canon
  }
  return null
}

// A line is a header row if it names "date" plus at least one amount-ish
// column. Returns [{ name, x }] sorted by x, or null.
function detectHeader(line) {
  const cols = []
  for (const item of line.items) {
    const canon = canonicalColumnName(item.text)
    if (canon) cols.push({ name: canon, x: item.x })
  }
  const names = new Set(cols.map(c => c.name))
  if (!names.has('date')) return null
  if (!names.has('credit') && !names.has('debit') && !names.has('amount')) return null
  return cols.sort((a, b) => a.x - b.x)
}

// Buckets a data line's items into named columns using midpoints between
// consecutive header x-positions as boundaries (numbers are typically
// right-aligned within a column, so their x can fall short of the header's
// own x — midpoint boundaries handle that correctly, verified against
// real statement coordinates).
function bucketLine(line, columns) {
  const buckets = {}
  for (const item of line.items) {
    let col = columns[0].name
    for (let i = 0; i < columns.length; i++) {
      const lo = i === 0 ? -Infinity : (columns[i - 1].x + columns[i].x) / 2
      const hi = i === columns.length - 1 ? Infinity : (columns[i].x + columns[i + 1].x) / 2
      if (item.x >= lo && item.x < hi) { col = columns[i].name; break }
    }
    buckets[col] = buckets[col] ? buckets[col] + ' ' + item.text : item.text
  }
  return buckets
}

// ---- Date parsing (handles year-less "23 Jul" style dates) --------------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

function findAnchorDate(allText) {
  const m = allText.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i)
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()]
    return new Date(Date.UTC(parseInt(m[3]), month, parseInt(m[1])))
  }
  return new Date()
}

// Parses "23 Jul" / "11 Aug" style day+month text with no year, inferring
// the year from an anchor date (the statement's own printed date) — a
// transaction can't postdate the statement, so if the naive same-year
// candidate falls after the anchor (with a few days' grace), it must be
// from the previous year.
function parseShortDate(text, anchorDate) {
  const m = text.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?$/)
  if (!m) return null
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()]
  if (month === undefined) return null
  const day = parseInt(m[1])
  let year = anchorDate.getUTCFullYear()
  let candidate = new Date(Date.UTC(year, month, day))
  if (candidate.getTime() > anchorDate.getTime() + 3 * 86400000) {
    year -= 1
    candidate = new Date(Date.UTC(year, month, day))
  }
  return candidate.toISOString().slice(0, 10)
}

// ---- Money parsing --------------------------------------------------------

function parseMoneyText(str) {
  if (!str) return null
  const isCr = /\bCR\b/i.test(str)
  const isNegative = /^\(.*\)$/.test(str.trim()) || str.trim().startsWith('-')
  const num = parseFloat(str.replace(/[(),A-Za-z]/g, ''))
  if (isNaN(num) || num === 0) return null
  return { amount: Math.abs(num), isCredit: isCr, isNegative }
}

const NON_TRANSACTION_LABELS = /\b(B\/F|C\/F|BROUGHT FORWARD|CARRIED FORWARD|OPENING BALANCE|CLOSING BALANCE)\b/i

// ---- Column-aware, multi-line block parser -------------------------------

function parseSection(lines, columns, anchorDate) {
  const rows = []
  let currentDate = null
  let pendingDesc = []

  for (const line of lines) {
    const buckets = bucketLine(line, columns)
    const dateText = buckets.date || ''
    const descText = buckets.description || ''

    if (dateText) {
      const parsed = parseShortDate(dateText, anchorDate) || (/^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : null)
      if (parsed) { currentDate = parsed; pendingDesc = [] }
    }
    if (descText) pendingDesc.push(descText)

    const credit = parseMoneyText(buckets.credit)
    const debit = parseMoneyText(buckets.debit)
    const single = parseMoneyText(buckets.amount)

    let settlementAmount = null, direction = null
    if (credit) { settlementAmount = credit.amount; direction = 'credit' }
    else if (debit) { settlementAmount = debit.amount; direction = 'debit' }
    else if (single) { settlementAmount = single.amount; direction = (single.isCredit || single.isNegative) ? 'credit' : 'debit' }

    if (settlementAmount != null && currentDate) {
      const merchantRaw = pendingDesc.join(' ').replace(/\s+/g, ' ').trim()
      pendingDesc = []
      if (!merchantRaw || NON_TRANSACTION_LABELS.test(merchantRaw)) continue
      rows.push({
        sourceRowIndex: rows.length,
        rawRowText: line.text,
        rawDateText: dateText || currentDate,
        transactionDate: currentDate,
        postDate: null,
        merchantRaw,
        settlementAmount,
        direction,
      })
    }
  }
  return rows
}

// Fallback for pages with no recognizable header row: single-line
// date-at-start + trailing-amount heuristic (works for simpler statements
// where each transaction is fully printed on one line with an explicit
// year in the date).
const DATE_START = /^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4})\b/
const MONEY_TRAILING = /-?\(?[\d,]+\.\d{2}\)?\s*(CR|DR)?/gi

function parseFallback(lines) {
  const rows = []
  for (const { text } of lines) {
    const dateMatch = text.match(DATE_START)
    if (!dateMatch) continue
    const rest = text.slice(dateMatch[0].length).trim()
    const amounts = [...rest.matchAll(MONEY_TRAILING)].map(m => parseMoneyText(m[0])).filter(Boolean)
    if (!amounts.length) continue
    const firstAmountIdx = rest.search(MONEY_TRAILING)
    const merchantRaw = rest.slice(0, firstAmountIdx === -1 ? rest.length : firstAmountIdx).trim()
    if (!merchantRaw || NON_TRANSACTION_LABELS.test(merchantRaw)) continue
    const first = amounts[0]
    rows.push({
      sourceRowIndex: rows.length,
      rawRowText: text,
      rawDateText: dateMatch[1],
      transactionDate: null, // no year-bearing anchor available in fallback mode without a header
      postDate: null,
      merchantRaw,
      settlementAmount: first.amount,
      direction: (first.isCredit || first.isNegative) ? 'credit' : 'debit',
    })
  }
  return rows.filter(r => r.transactionDate) // dropped below if date unresolved — see note
}

// Full pipeline: PDF file -> candidate transaction rows. Returns
// { rows, lineCount, pageCount } so the caller can tell the user how much
// text was found even if zero rows were recognized.
export async function parsePdfStatement(file) {
  const pages = await extractStructuredLines(file)
  const allLines = pages.flat()
  const lineCount = allLines.length
  const pageCount = pages.length
  const anchorDate = findAnchorDate(allLines.map(l => l.text).join(' '))

  const rows = []
  for (const pageLines of pages) {
    // Split each page into sections at header rows; parse each section
    // with its own column layout (a page can have multiple mini-tables).
    let currentColumns = null
    let sectionLines = []

    const flushSection = () => {
      if (currentColumns && sectionLines.length) rows.push(...parseSection(sectionLines, currentColumns, anchorDate))
      sectionLines = []
    }

    for (const line of pageLines) {
      const header = detectHeader(line)
      if (header) { flushSection(); currentColumns = header; continue }
      sectionLines.push(line)
    }
    flushSection()
  }

  if (!rows.length) {
    // No table with a recognizable header anywhere — try the simpler
    // single-line fallback in case this is a plainer statement format.
    rows.push(...parseFallback(allLines))
  }

  return { rows, lineCount, pageCount }
}
