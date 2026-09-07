// X Transfer (CNY settlement platform) CSV import. Structurally different
// from a normal bank/card statement — mapCsvRecords/COLUMN_ALIASES can't
// handle it — because every real-world outgoing payment is split across
// TWO rows: a 'Service fee' row immediately followed by a same-timestamp
// 'CNY Settlement to Personal Account' row. The bookkeeper wants these
// combined into one transaction (the fee is money that left the account
// for that same transfer, not a separate event — same treatment as
// Upload.jsx's handling-charge field), and only the date portion of
// "Time" kept (it's a full datetime, e.g. "5/8/2026 16:58").
import { parseStatementDate } from './paymentMatching'

// Recipient's-name (Chinese, from the CSV's own "Recipient's name" column)
// -> the label the bookkeeper actually uses. A name with no entry here is
// still imported (never silently dropped — see LESSONS_LEARNED.md) with
// its raw Chinese name, rather than guessed at.
export const XTRANSFER_RECIPIENT_LABELS = {
  '仇志贤': 'Eddie - ICBC',
  '程瑞勇': 'Vendor XinChengLe',
  '温石林': 'SZ ChuangLian',
  '蒋素': 'Factory Rent',
}

// Strips both straight (') and curly (’) apostrophes before comparing —
// the actual export uses a curly one ("Recipient’s name"), which a plain
// substring match on "recipient's name" silently never finds.
const normalize = s => s.toLowerCase().replace(/['’]/g, '')

function findCol(headers, needle) {
  const lower = headers.map(h => normalize(h))
  const i = lower.findIndex(h => h.includes(normalize(needle)))
  return i === -1 ? null : headers[i]
}

// Detects the X Transfer export shape from its header row. The
// payer/recipient/bank columns are distinctive enough that a false
// positive on some other bank's CSV is very unlikely.
export function isXTransferCsv(headers) {
  return !!findCol(headers, "recipient's name") && !!findCol(headers, 'paying bank')
}

// Maps raw X Transfer CSV rows into the paymentTransactions row shape.
export function mapXTransferRecords(records, headers) {
  const timeCol = findCol(headers, 'time')
  const categoryCol = findCol(headers, 'category')
  const detailsCol = findCol(headers, 'details')
  const amountCol = findCol(headers, 'amount')
  const balanceCol = findCol(headers, 'balance')
  const recipientCol = findCol(headers, "recipient's name")

  const parseAmount = v => parseFloat((v || '').replace(/,/g, ''))

  const rows = []
  let pendingFee = null // { time, amount, index } — a 'Service fee' row not yet folded into its settlement

  // A fee row not followed by its matching settlement (shouldn't happen in
  // practice, but this file format is new to the app) is still imported as
  // its own transaction rather than silently discarded.
  function flushOrphanFee() {
    if (!pendingFee) return
    rows.push({
      sourceRowIndex: pendingFee.index,
      rawRowText: pendingFee.rawRowText,
      rawDateText: pendingFee.time,
      transactionDate: parseStatementDate(pendingFee.time),
      postDate: null,
      merchantRaw: 'CNY Settlement service fee',
      settlementAmount: Math.abs(pendingFee.amount),
      direction: 'debit',
      balanceAfter: pendingFee.balance,
    })
    pendingFee = null
  }

  records.forEach((rec, i) => {
    const category = (rec[categoryCol] || '').trim()
    const time = timeCol ? (rec[timeCol] || '').trim() : ''
    if (!category && !time) return // trailing blank rows in the export

    const amount = parseAmount(rec[amountCol])
    const balance = balanceCol && rec[balanceCol] !== '' ? parseAmount(rec[balanceCol]) : null

    if (category === 'Service fee') {
      flushOrphanFee() // a fee can't itself have a pending fee before it
      pendingFee = { time, amount, index: i, rawRowText: JSON.stringify(rec), balance }
      return
    }

    if (category === 'CNY Settlement to Personal Account') {
      const feeAmount = pendingFee && pendingFee.time === time ? pendingFee.amount : (flushOrphanFee(), 0)
      pendingFee = null
      const recipientRaw = recipientCol ? (rec[recipientCol] || '').trim() : ''
      const label = XTRANSFER_RECIPIENT_LABELS[recipientRaw] || recipientRaw || (rec[detailsCol] || '').trim()
      rows.push({
        sourceRowIndex: i,
        rawRowText: JSON.stringify(rec),
        rawDateText: time,
        transactionDate: parseStatementDate(time),
        postDate: null,
        merchantRaw: label,
        settlementAmount: Math.abs(amount) + Math.abs(feeAmount),
        direction: 'debit',
        balanceAfter: balance,
      })
      return
    }

    flushOrphanFee()

    // Covers both a 'buy' (RMB account, CNY arriving — credit) and a
    // 'sell' (HKD account, HKD leaving to be exchanged — debit) amount;
    // sign alone decides direction, no special-casing needed per currency.
    if (category === 'Market order') {
      rows.push({
        sourceRowIndex: i,
        rawRowText: JSON.stringify(rec),
        rawDateText: time,
        transactionDate: parseStatementDate(time),
        postDate: null,
        merchantRaw: (rec[detailsCol] || 'Market order').trim(),
        settlementAmount: Math.abs(amount),
        direction: amount < 0 ? 'debit' : 'credit',
        balanceAfter: balance,
      })
      return
    }

    // Money credited into the X Transfer account from an outside source
    // (e.g. the HKD statement's "Add money - from UNITED ART METALS
    // FACTORY LIMITED") — always a credit.
    if (category === 'Add money') {
      rows.push({
        sourceRowIndex: i,
        rawRowText: JSON.stringify(rec),
        rawDateText: time,
        transactionDate: parseStatementDate(time),
        postDate: null,
        merchantRaw: (rec[detailsCol] || 'Add money').trim(),
        settlementAmount: Math.abs(amount),
        direction: 'credit',
        balanceAfter: balance,
      })
      return
    }

    // Customer payment received into the account (e.g. the EUR
    // statement's "Receive money-from PHU SOVENIR DAWID REITER") —
    // always a credit. Kept distinct from 'Add money' (money moved in
    // from United Art itself) since one is income from a customer and
    // the other is an internal transfer.
    if (category === 'Receive money') {
      rows.push({
        sourceRowIndex: i,
        rawRowText: JSON.stringify(rec),
        rawDateText: time,
        transactionDate: parseStatementDate(time),
        postDate: null,
        merchantRaw: (rec[detailsCol] || 'Receive money').trim(),
        settlementAmount: Math.abs(amount),
        direction: 'credit',
        balanceAfter: balance,
      })
      return
    }

    // Unrecognized category — import rather than drop (hard rule, see
    // LESSONS_LEARNED.md's "duplicates must surface, never silently skip"
    // — the same principle applies to any financial row).
    if (!isNaN(amount) && amount !== 0) {
      rows.push({
        sourceRowIndex: i,
        rawRowText: JSON.stringify(rec),
        rawDateText: time,
        transactionDate: parseStatementDate(time),
        postDate: null,
        merchantRaw: (rec[detailsCol] || category || 'Unknown').trim(),
        settlementAmount: Math.abs(amount),
        direction: amount < 0 ? 'debit' : 'credit',
        balanceAfter: balance,
      })
    }
  })
  flushOrphanFee()

  return rows
}
