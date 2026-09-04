// Extracts transaction-like rows from a digital (text-based) bank/credit
// card statement PDF. Statement PDFs are tables, and pdf.js gives us glyph
// positions rather than rows/columns, so this reconstructs lines by
// clustering text items with close y-coordinates, then sorts each line
// left-to-right by x-coordinate.
//
// This only works on text-based PDFs (the normal case for a bank/card
// statement downloaded from online banking). A scanned/photographed PDF
// has no text layer and will extract nothing — callers must handle that
// and tell the user, not guess at numbers from an image.
//
// Because layout varies a lot bank-to-bank, extraction here is heuristic.
// Unlike CSV import (structured, trusted), callers MUST show the parsed
// rows to the user for review before writing anything to Firestore.

import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { parseStatementDate } from './paymentMatching'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const Y_TOLERANCE = 2.5 // points; items within this y-distance are treated as the same line

async function extractLines(file) {
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const lines = []

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()
    const items = content.items.filter(it => it.str.trim() !== '')

    // Cluster items into lines by y-position
    const clusters = []
    for (const item of items) {
      const y = item.transform[5]
      let cluster = clusters.find(c => Math.abs(c.y - y) <= Y_TOLERANCE)
      if (!cluster) { cluster = { y, items: [] }; clusters.push(cluster) }
      cluster.items.push(item)
    }

    clusters.sort((a, b) => b.y - a.y) // top to bottom
    for (const cluster of clusters) {
      cluster.items.sort((a, b) => a.transform[4] - b.transform[4]) // left to right
      const text = cluster.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim()
      if (text) lines.push({ page: pageNum, text })
    }
  }
  return lines
}

const DATE_START = /^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4})\b/
const MONEY = /-?\(?[\d,]+\.\d{2}\)?\s*(CR|DR)?/gi

function parseMoney(str) {
  const isCr = /CR/i.test(str)
  const isNegative = /^\(.*\)$/.test(str.trim()) || str.trim().startsWith('-')
  const num = parseFloat(str.replace(/[(),A-Za-z]/g, ''))
  if (isNaN(num)) return null
  return { amount: Math.abs(num), isCredit: isCr, isNegative }
}

// Turns reconstructed statement lines into the same row shape
// mapCsvRecords produces, so both feed the same import pipeline in
// PaymentSources.jsx.
export function parseStatementLines(lines) {
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const { text } = lines[i]
    const dateMatch = text.match(DATE_START)
    if (!dateMatch) continue

    const rawDateText = dateMatch[1]
    const transactionDate = parseStatementDate(rawDateText)
    if (!transactionDate) continue

    const rest = text.slice(dateMatch[0].length).trim()
    const amounts = [...rest.matchAll(MONEY)].map(m => parseMoney(m[0])).filter(Boolean)
    if (!amounts.length) continue

    // Description is everything before the first matched amount.
    const firstAmountIdx = rest.search(MONEY)
    const merchantRaw = rest.slice(0, firstAmountIdx === -1 ? rest.length : firstAmountIdx).trim()
    if (!merchantRaw) continue

    // Heuristics for common statement layouts:
    // 1 number  -> that's the transaction amount, running balance absent
    // 2 numbers -> amount, then running balance (most common bank/card layout)
    // 3 numbers -> debit, credit, balance (one of debit/credit is usually the amount, other is blank/zero — but a
    //              text line collapses blanks, so 3 numbers usually means debit AND credit both printed, rare;
    //              treat first non-zero of the first two as the amount)
    let settlementAmount, direction
    if (amounts.length >= 3) {
      const [debit, credit] = amounts
      if (debit.amount > 0 && (amounts[1]?.amount ?? 0) === 0) { settlementAmount = debit.amount; direction = 'debit' }
      else { settlementAmount = credit.amount; direction = 'credit' }
    } else {
      const first = amounts[0]
      settlementAmount = first.amount
      direction = (first.isCredit || first.isNegative) ? 'credit' : 'debit'
    }

    rows.push({
      sourceRowIndex: rows.length,
      rawRowText: text,
      rawDateText,
      transactionDate,
      postDate: null,
      merchantRaw,
      settlementAmount,
      direction,
    })
  }
  return rows
}

// Full pipeline: PDF file -> candidate transaction rows. Returns
// { rows, lineCount, pageCount } so the caller can tell the user how much
// text was found even if zero rows were recognized (helps distinguish
// "wrong layout" from "this is a scanned image with no text layer").
export async function parsePdfStatement(file) {
  const lines = await extractLines(file)
  const rows = parseStatementLines(lines)
  return { rows, lineCount: lines.length, pageCount: new Set(lines.map(l => l.page)).size }
}
