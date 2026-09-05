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
const DATE_TOKEN = /^\d{1,2}[A-Za-z]{3}\b|^\d{1,2}[\/\-.]\d{1,2}|^\d{1,2}\s[A-Za-z]{3}\b/
const DATE_HEADER_NAMES = new Set(['date', 'transDate', 'postDate'])

// The description column is the one column with no fixed shape: a
// multi-word merchant description can arrive from the PDF as a single
// merged text run, or as one item per word, depending on the PDF's
// internal text-showing operators (verified: the exact same kind of
// content comes out as one span via one extraction library and several
// per-word items via another). It has no stable x to calibrate against
// either way. Every other column (date-shaped or money-shaped) is a
// single short token with a consistent-enough x to cluster on.
const WIDE_COLUMNS = new Set(['description'])

// Header labels don't always sit at the same x as the data beneath them —
// a wide column's label can be centered or left-flush over data that
// starts well to the left of the label's own text (verified: the same
// statement prints "Description of transaction" starting at x=267 while
// every actual description value starts at x=137). So the header is only
// trusted for column NAMES and their LEFT-TO-RIGHT ORDER; actual
// boundaries for the narrow (date/amount-shaped) columns come from
// clustering the x-positions of matching ITEMS specifically — not every
// item on a qualifying line, which would let a multi-word description's
// scattered per-word items corrupt the clustering — filtered further to
// clusters with enough population to be a real column (a stray sidebar
// number that slips past the row filter only ever forms a tiny cluster
// next to columns with one entry per transaction). The wide description
// column is never clustered directly; its boundary is simply the gap
// between its neighboring narrow columns' resolved anchors. Falls back
// to the header's own x-positions if the narrow columns don't cleanly
// resolve to the same count as the header's narrow columns.
function clusterXs(xs, tolerance) {
  const sorted = [...xs].sort((a, b) => a - b)
  const clusters = []
  for (const x of sorted) {
    const last = clusters[clusters.length - 1]
    if (last && x - last.xs[last.xs.length - 1] <= tolerance) last.xs.push(x)
    else clusters.push({ xs: [x] })
  }
  return clusters
}

function resolveColumns(headerCols, sectionLines, tolerance = 20) {
  const headerSorted = [...headerCols].sort((a, b) => a.x - b.x)
  const narrowHeaders = headerSorted.filter(h => !WIDE_COLUMNS.has(h.name))
  const narrowDateHeaders = narrowHeaders.filter(h => DATE_HEADER_NAMES.has(h.name))
  const narrowMoneyHeaders = narrowHeaders.filter(h => !DATE_HEADER_NAMES.has(h.name))

  const rowLines = sectionLines.filter(l => l.items.some(it => AMOUNT_TOKEN.test(it.text) || DATE_TOKEN.test(it.text)))
  const minPopulation = Math.max(2, rowLines.length * 0.3)

  // Date-type columns are calibrated ONLY from each line's leading items
  // (as many as there are date columns — e.g. the first 2 for a Post
  // date/Trans date layout) — never from a date-shaped token anywhere
  // else on the line. Verified: a statement can print an unrelated
  // processing-date reference mid-description ("...HC125C3193203289
  // 31DEC") that also matches a date pattern; pooling it alongside the
  // real Date column's values pulled the whole column's calibration onto
  // that noise instead, since it happened to have similar population.
  const dateXs = narrowDateHeaders.length
    ? rowLines.flatMap(l => l.items.slice(0, narrowDateHeaders.length).filter(it => DATE_TOKEN.test(it.text)).map(it => it.x))
    : []
  // Money-type columns can stay pooled from anywhere on the line — a
  // foreign-currency sub-amount matching the same shape is handled by the
  // min-based boundary below, not by excluding it from calibration.
  const moneyXs = rowLines.flatMap(l => l.items.filter(it => AMOUNT_TOKEN.test(it.text)).map(it => it.x))

  const dateClusters = clusterXs(dateXs, tolerance).filter(c => c.xs.length >= minPopulation)
  const moneyClusters = clusterXs(moneyXs, tolerance).filter(c => c.xs.length >= minPopulation)
  if (dateClusters.length !== narrowDateHeaders.length || moneyClusters.length !== narrowMoneyHeaders.length) return headerSorted

  const toAnchor = c => ({ x: c.xs.reduce((a, b) => a + b, 0) / c.xs.length, min: Math.min(...c.xs) })
  const dateAnchors = dateClusters.map(toAnchor)
  const moneyAnchors = moneyClusters.map(toAnchor)
  // Recombine in the header's left-to-right order (date columns and money
  // columns were calibrated separately, but a layout can interleave them
  // with the wide column in between, e.g. [date, description, amount]).
  const narrowAnchors = []
  let di = 0, mi = 0
  for (const h of narrowHeaders) {
    narrowAnchors.push(DATE_HEADER_NAMES.has(h.name) ? dateAnchors[di++] : moneyAnchors[mi++])
  }

  const result = []
  let i = 0
  for (const h of headerSorted) {
    if (WIDE_COLUMNS.has(h.name)) {
      const prevX = result.length ? result[result.length - 1].x : -Infinity
      const nextMin = i < narrowAnchors.length ? narrowAnchors[i].min : Infinity
      // The wide column's own content isn't clusterable (its later words
      // scatter across its full width — verified: on foreign-currency
      // lines, description runs all the way out to an embedded currency
      // amount well past where domestic lines end), but its FIRST word per
      // row is — sitting at a fixed x just as reliably as any narrow
      // column, regardless of how many items the rest of the description
      // gets split into. Calibrating on that leftmost word, rather than
      // guessing the midpoint of the entire gap to the next narrow column,
      // is what keeps a wide gap from swallowing real description text
      // into the previous narrow column's bucket.
      const leftWordXs = rowLines
        .map(l => l.items.map(it => it.x).filter(x => x > prevX + 5 && x < nextMin - 5))
        .filter(xs => xs.length)
        .map(xs => Math.min(...xs))
        .sort((a, b) => a - b)
      const leftClusters = []
      for (const x of leftWordXs) {
        const last = leftClusters[leftClusters.length - 1]
        if (last && x - last.xs[last.xs.length - 1] <= tolerance) last.xs.push(x)
        else leftClusters.push({ xs: [x] })
      }
      const bestCluster = leftClusters.sort((a, b) => b.xs.length - a.xs.length)[0]
      const anchorX = bestCluster ? bestCluster.xs.reduce((a, b) => a + b, 0) / bestCluster.xs.length
        : (isFinite(prevX) && isFinite(nextMin) ? (prevX + nextMin) / 2 : (isFinite(nextMin) ? nextMin : (isFinite(prevX) ? prevX : h.x)))
      result.push({ name: h.name, x: anchorX })
    } else {
      result.push({ name: h.name, x: narrowAnchors[i].x, min: narrowAnchors[i].min })
      i++
    }
  }
  return result
}

// Buckets a data line's items into named columns. The boundary between two
// columns uses the RIGHT column's own observed left edge (min) when known,
// rather than a plain midpoint of both columns' representative x's — a
// wide description column can run much further right on some rows than
// others (e.g. a foreign-currency line's embedded amount notation), and a
// mean-based midpoint would then cut into that column's own territory,
// pulling a value that actually belongs to the following narrow column
// (verified: the real HKD amount was being lost to the description bucket
// merging with a foreign sub-amount) into the wrong column, or vice versa.
// Falls back to the midpoint when the right column has no known min (i.e.
// it's the wide column itself).
function bucketLine(line, columns) {
  const buckets = {}
  for (const item of line.items) {
    let col = columns[0].name
    for (let i = 0; i < columns.length; i++) {
      const prev = columns[i - 1]
      const next = columns[i + 1]
      const lo = i === 0 ? -Infinity : (columns[i].min != null ? columns[i].min - 5 : (prev.x + columns[i].x) / 2)
      const hi = !next ? Infinity : (next.min != null ? next.min - 5 : (columns[i].x + next.x) / 2)
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
// "Brought forward" / "opening balance" restates the balance the statement
// STARTS with; "carried forward" / "closing balance" restates what it ENDS
// with — distinguished so the two can be used as independent statement-level
// checkpoints (see validateStatementTotals in duplicateDetection.js), not
// just dropped as noise.
const OPENING_BALANCE_LABELS = /\b(B\/F|BROUGHT FORWARD|OPENING BALANCE|PREVIOUS BALANCE)\b/i
const CLOSING_BALANCE_LABELS = /\b(C\/F|CARRIED FORWARD|CLOSING BALANCE)\b/i
const INSTALMENT_NOTE = /(\d+)(?:st|nd|rd|th)\s+of\s+(\d+)\s+instal?ments?/i

// ---- Column-aware, multi-line block parser -------------------------------

// `balanceMarkers` (mutated in place) collects any opening/closing balance
// restatement lines found in this section, tagged with which page they came
// from — the caller uses the first opening marker and the last closing
// marker across the whole document as the statement's overall totals
// checkpoints.
function parseSection(lines, columns, anchorDate, pageNumber, balanceMarkers) {
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

    // Some page furniture never touches a date bucket at all (verified: a
    // "Minimum payment summary" sidebar box's rows read as plain
    // description+amount, indistinguishable in bucket shape from a bank
    // statement's legitimate date-less continuation transaction under a
    // shared date). The tell is POSITION: a genuine continuation line's
    // content starts flush with the description column's own calibrated
    // left edge (its first word, wherever the table's real text starts);
    // sidebar content starts wherever that unrelated box happens to sit,
    // which in every case seen so far is well to the right of it. Only
    // applies when there's no date to anchor the line as genuine outright.
    if (!parsedDate && line.items.length) {
      const descColumn = columns.find(c => c.name === 'description')
      if (descColumn && Math.abs(line.items[0].x - descColumn.x) > 25) continue
    }

    const credit = parseMoneyText(buckets.credit)
    const debit = parseMoneyText(buckets.debit)
    const single = parseMoneyText(buckets.amount)
    const balance = parseMoneyText(buckets.balance)

    // A "balance b/f" or "balance c/f" restatement line is metadata about
    // the ledger, not a transaction — capture the figure as a checkpoint
    // for statement-level totals validation, and skip it entirely before it
    // can pollute the next real transaction's accumulated description or
    // be miscounted as a purchase/payment itself.
    if (OPENING_BALANCE_LABELS.test(line.text) || CLOSING_BALANCE_LABELS.test(line.text)) {
      const markerAmount = balance || single || credit || debit
      if (markerAmount) {
        balanceMarkers.push({
          type: OPENING_BALANCE_LABELS.test(line.text) ? 'opening' : 'closing',
          amount: markerAmount.amount * (markerAmount.isNegative ? -1 : 1),
          pageNumber,
        })
      }
      continue
    }

    if (parsedDate) { currentDate = parsedDate; pendingDesc = [] }
    if (descText) pendingDesc.push(descText)

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
        pageNumber,
        rawRowText: line.text,
        rawDateText: dateText || currentDate,
        transactionDate: currentDate,
        postDate: postDateText ? parseDateBucket(postDateText) : null,
        merchantRaw,
        settlementAmount,
        direction,
        // The statement's own running balance after this line, when printed
        // — used to tell a genuine repeat transaction (the balance actually
        // moves twice) apart from an accidental double-parse of one line
        // (the balance wouldn't have moved at all) — see paymentMatching.js.
        balanceAfter: balance ? balance.amount * (balance.isNegative ? -1 : 1) : null,
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
      balanceAfter: null, // no column-aware balance in single-line fallback mode
    })
  }
  return rows.filter(r => r.transactionDate) // dropped below if date unresolved — see note
}

// Catches an opening/closing balance restatement that sits OUTSIDE any
// recognized table section entirely (verified: "Opening Balance: HKD
// 10,000.00" commonly prints above the transaction table's own header row,
// so it never reaches parseSection's column-bucketed logic at all). Works
// directly off raw line text rather than resolved columns — deliberately
// tolerant, since this line's layout varies far more than a table row's.
// Guarded to short lines only, so a long disclaimer paragraph that happens
// to mention "previous balance" in prose can't be mistaken for one.
function extractBalanceMarkersFromRawLines(lines) {
  const markers = []
  for (const { text } of lines) {
    if (text.length > 120) continue
    const isOpening = OPENING_BALANCE_LABELS.test(text)
    const isClosing = CLOSING_BALANCE_LABELS.test(text)
    if (!isOpening && !isClosing) continue
    const matches = [...text.matchAll(MONEY_TRAILING)].map(m => parseMoneyText(m[0])).filter(Boolean)
    if (!matches.length) continue
    const last = matches[matches.length - 1]
    markers.push({ type: isOpening ? 'opening' : 'closing', amount: last.amount * (last.isNegative ? -1 : 1) })
  }
  return markers
}

// Full pipeline: PDF file -> candidate transaction rows. Returns
// { rows, lineCount, pageCount, openingBalance, closingBalance } so the
// caller can tell the user how much text was found even if zero rows were
// recognized, and can validate the statement's own totals independently of
// per-row parsing (see validateStatementTotals in duplicateDetection.js).
// openingBalance/closingBalance are null when no restatement line was found
// anywhere in the document — never guessed.
export async function parsePdfStatement(file) {
  const pages = await extractStructuredLines(file)
  const allLines = pages.flat()
  const lineCount = allLines.length
  const pageCount = pages.length
  const anchorDate = findAnchorDate(allLines.map(l => l.text).join(' '))

  // Whole-document scan first, so its entries come first in the array for
  // any marker also independently found inside a table section below (both
  // point at the same value when that happens — harmless duplication).
  const balanceMarkers = extractBalanceMarkersFromRawLines(allLines)

  const rows = []
  let pageNum = 0
  for (const pageLines of pages) {
    pageNum++
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
        rows.push(...parseSection(tableLines, columns, anchorDate, pageNum, balanceMarkers))
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

  // sourceRowIndex is assigned per-section above (so it resets per table),
  // which isn't a reliable global position — reassign it here as the row's
  // true, monotonic position in the statement's own printed order (never
  // resorted by date), so two same-day rows keep the sequence they must be
  // validated in.
  rows.forEach((r, i) => { r.sourceRowIndex = i })

  const openingMarkers = balanceMarkers.filter(m => m.type === 'opening')
  const closingMarkers = balanceMarkers.filter(m => m.type === 'closing')

  return {
    rows,
    lineCount,
    pageCount,
    openingBalance: openingMarkers.length ? openingMarkers[0].amount : null,
    closingBalance: closingMarkers.length ? closingMarkers[closingMarkers.length - 1].amount : null,
  }
}
