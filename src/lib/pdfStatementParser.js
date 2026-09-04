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
  transDate: ['trans date', 'transaction date', 'txn date'],
  postDate: ['post date', 'posting date'],
  description: ['transaction details', 'description', 'description of transaction', 'narrative', 'details', 'particulars', '進支詳情', '交易詳情', '摘要', '交易說明'],
  credit: ['deposit', 'credit', '存入'],
  debit: ['withdrawal', 'debit', '支出'],
  amount: ['amount', 'amount (hkd)'],
  balance: ['balance', '結餘'],
}

function canonicalColumnName(text) {
  const t = text.toLowerCase().trim()
  for (const [canon, aliases] of Object.entries(COLUMN_LABELS)) {
    if (aliases.some(a => t === a)) return canon
  }
  return null
}

// A line is a header row if it names a date column plus at least one
// amount-ish column. Returns [{ name, x }] sorted by x, or null.
function detectHeader(line) {
  const cols = []
  for (const item of line.items) {
    const canon = canonicalColumnName(item.text)
    if (canon) cols.push({ name: canon, x: item.x })
  }
  const names = new Set(cols.map(c => c.name))
  if (!names.has('date') && !names.has('transDate')) return null
  if (!names.has('credit') && !names.has('debit') && !names.has('amount')) return null
  return cols.sort((a, b) => a.x - b.x)
}

// A "section" (everything between one header and the next) can contain
// page content that has nothing to do with the table — a sidebar summary
// box, a footer notice paragraph — sharing the same y-range as table rows
// simply because they're printed in a different column on the same part
// of the page (verified: an HSBC credit card statement's "Minimum payment
// summary" box and mailing-address footer both fall inside the
// transaction table's section). Only lines that actually look like a
// transaction row or its continuation carry a date-shaped or
// money-shaped token — restricting clustering to those lines' items
// excludes that unrelated content before it can corrupt column detection.
const AMOUNT_TOKEN = /\d[\d,]*\.\d{2}/
const DATE_TOKEN = /^\d{1,2}[A-Za-z]{3}\b|^\d{1,2}[\/\-.]\d{1,2}/

// Header labels don't always sit at the same x as the data beneath them —
// a wide column's label can be centered or left-flush over data that
// starts well to the left of the label's own text (verified: the same
// statement prints "Description of transaction" starting at x=267 while
// every actual description value starts at x=137). So the header is only
// trusted for column NAMES and their LEFT-TO-RIGHT ORDER; actual
// boundaries come from clustering the real data's x-positions — filtered
// to rows that look like real transactions, then to only the clusters
// with enough population to be a real column (a stray sidebar number that
// slips past the row filter still only ever forms a tiny, easily
// distinguished cluster next to columns with one entry per transaction).
// Falls back to the header's own x-positions if the data doesn't cleanly
// resolve to the same number of columns as the header names.
function resolveColumns(headerCols, sectionLines, tolerance = 20) {
  const headerSorted = [...headerCols].sort((a, b) => a.x - b.x)
  const rowLines = sectionLines.filter(l => l.items.some(it => AMOUNT_TOKEN.test(it.text) || DATE_TOKEN.test(it.text)))
  const xs = rowLines.flatMap(l => l.items.map(it => it.x)).sort((a, b) => a - b)
  const clusters = []
  for (const x of xs) {
    const last = clusters[clusters.length - 1]
    if (last && x - last.xs[last.xs.length - 1] <= tolerance) last.xs.push(x)
    else clusters.push({ xs: [x] })
  }
  const minPopulation = Math.max(2, rowLines.length * 0.3)
  const major = clusters.filter(c => c.xs.length >= minPopulation)
  const anchors = major.map(c => c.xs.reduce((a, b) => a + b, 0) / c.xs.length)
  if (anchors.length === headerSorted.length) {
    return headerSorted.map((h, i) => ({ name: h.name, x: anchors[i] }))
  }
  return headerSorted
}

// Buckets a data line's items into named columns using midpoints between
// consecutive column x-positions as boundaries.
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
  // Matches both full ("22 August 2026") and abbreviated ("17 AUG 2026")
  // month names — different statement templates use different forms.
  const m = allText.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/)
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()]
    if (month !== undefined) return new Date(Date.UTC(parseInt(m[3]), month, parseInt(m[1])))
  }
  return new Date()
}

// Parses year-less day+month text, inferring the year from an anchor date
// (the statement's own printed date) — a transaction can't postdate the
// statement, so if the naive same-year candidate falls after the anchor
// (with a few days' grace), it must be from the previous year. Handles
// both "23 Jul" (space, one statement format) and "18JUL" (no space,
// another statement's format) — verified against two real banks' PDFs.
function parseShortDate(text, anchorDate) {
  const m = text.trim().match(/^(\d{1,2})\s*([A-Za-z]{3,9})\.?$/)
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
  // "7,820.57CR" has no word-boundary between digit and letter, so \bCR\b
  // never matches — CR is a suffix directly on the number, not a separate word.
  const isCr = /CR\s*$/i.test(str.trim())
  const isNegative = /^\(.*\)$/.test(str.trim()) || str.trim().startsWith('-')
  const num = parseFloat(str.replace(/[(),A-Za-z]/g, ''))
  if (isNaN(num) || num === 0) return null
  return { amount: Math.abs(num), isCredit: isCr, isNegative }
}

const NON_TRANSACTION_LABELS = /\b(B\/F|C\/F|BROUGHT FORWARD|CARRIED FORWARD|OPENING BALANCE|CLOSING BALANCE|PREVIOUS BALANCE)\b/i
const INSTALMENT_NOTE = /(\d+)(?:st|nd|rd|th)\s+of\s+(\d+)\s+instal?ments?/i

// ---- Column-aware, multi-line block parser -------------------------------

function parseSection(lines, columns, anchorDate) {
  const rows = []
  let currentDate = null
  let pendingDesc = []

  const parseDateBucket = text => parseShortDate(text, anchorDate) || (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null)

  for (const line of lines) {
    const buckets = bucketLine(line, columns)
    // Prefer the transaction date over the posting date when a statement
    // prints both (a credit card's "Trans date" is when the purchase
    // happened; "Post date" is bank-processing lag — the former is what
    // should match against a receipt's date).
    const dateText = buckets.transDate || buckets.date || ''
    const postDateText = buckets.postDate || ''
    const descText = buckets.description || ''

    // A note like "12th of 12 instalments" has no date or amount of its
    // own — it's metadata about the transaction just emitted.
    const instalmentMatch = line.text.match(INSTALMENT_NOTE)
    if (instalmentMatch && rows.length) {
      rows[rows.length - 1].installmentIndicator = true
      rows[rows.length - 1].installmentNumber = parseInt(instalmentMatch[1])
      rows[rows.length - 1].installmentTotal = parseInt(instalmentMatch[2])
      continue
    }

    const parsedDate = dateText ? parseDateBucket(dateText) : null
    // Page content that shares the table's x-range by coincidence (verified:
    // a footer paragraph printed flush against the page's left margin,
    // which is also where the Date column starts) can populate a
    // date-labelled bucket with garbage that isn't a date at all. A
    // genuine row's date bucket (whichever of date/transDate/postDate the
    // layout has) is either cleanly empty (a continuation line) or a real,
    // parseable date — never populated-but-unparseable. Reject any line
    // that breaks that invariant, rather than trying to salvage its
    // description text — this is what keeps such page furniture from
    // being stitched into a transaction's description and silently
    // producing a phantom row. (This must check every date-type bucket,
    // not just whichever populated dateText — a bank statement can have
    // one date column and multiple genuine transactions per date, so a
    // broader "any other bucket populated without a date" rule would
    // wrongly reject its legitimate multi-line, date-less continuation
    // rows that carry an amount.)
    const dateColumnNames = columns.filter(c => c.name === 'date' || c.name === 'transDate' || c.name === 'postDate').map(c => c.name)
    const hasUnparseableDate = dateColumnNames.some(name => buckets[name] && !parseDateBucket(buckets[name]))
    if (hasUnparseableDate) continue

    if (parsedDate) { currentDate = parsedDate; pendingDesc = [] }
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
        postDate: postDateText ? parseDateBucket(postDateText) : null,
        merchantRaw,
        settlementAmount,
        direction,
        installmentIndicator: false,
        installmentNumber: null,
        installmentTotal: null,
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
    // with its own column layout (a page can have multiple mini-tables,
    // and multi-page statements repeat the header on every page).
    let currentHeader = null
    let sectionLines = []

    const flushSection = () => {
      if (currentHeader && sectionLines.length) {
        const columns = resolveColumns(currentHeader, sectionLines)
        // Resolving columns from real transaction rows isn't enough on its
        // own — unrelated page content (a sidebar box, a footer notice)
        // that shares the section's y-range would still get bucketed and
        // misread as a transaction. A genuine table line (row or
        // continuation) always has an item flush against one of the
        // resolved column positions; sidebar/footer text doesn't.
        const tableLines = sectionLines.filter(l => l.items.some(it => columns.some(c => Math.abs(it.x - c.x) <= 15)))
        rows.push(...parseSection(tableLines, columns, anchorDate))
      }
      sectionLines = []
    }

    for (const line of pageLines) {
      const header = detectHeader(line)
      if (header) { flushSection(); currentHeader = header; continue }
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
