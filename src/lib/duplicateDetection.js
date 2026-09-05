// Pure, dependency-free duplicate-transaction classification for statement
// imports. Deliberately conservative per the accounting requirement: same
// date + same amount is never enough on its own to call two rows a
// duplicate — real statements routinely contain genuine separate
// transactions on the same day for the same amount (two supermarket trips,
// two identical subscription charges, etc). This module only classifies;
// callers decide what to write and how to render review actions — no
// Firestore access here.

import { normalizeMerchant } from './paymentMatching'

export const DUPLICATE_STATUS_LABELS = {
  verified_separate: 'Verified Separate',
  possible_duplicate: 'Possible Duplicate',
  confirmed_duplicate: 'Confirmed Duplicate Import',
  needs_review: 'Needs Review',
}

// Walks a batch of rows in their original statement order (never re-sorted
// by date — two same-day rows must keep their printed order) and checks
// each one's reported balance against what the previous row's balance plus
// this row's own credit/debit implies. Mutates nothing; returns a new array
// with `balanceSequenceValid` (true/false/null — null when either balance
// is unavailable to check) and `expectedBalance` attached.
//
// Scope note: this validates consistency WITHIN the batch being imported,
// using each row's own printed balance as the running total. It does not
// reach back into previously-imported statements' balances, since batches
// commonly cover non-overlapping periods and stitching history in would
// require assuming no gaps — a guess this module avoids making.
export function annotateBalanceSequence(rows, tolerance = 0.02) {
  let prevBalance = null
  const out = []
  for (const r of rows) {
    let balanceSequenceValid = null
    let expectedBalance = null
    if (prevBalance != null && r.balanceAfter != null) {
      expectedBalance = r.direction === 'credit' ? prevBalance + r.settlementAmount : prevBalance - r.settlementAmount
      balanceSequenceValid = Math.abs(expectedBalance - r.balanceAfter) <= tolerance
    }
    out.push({ ...r, balanceSequenceValid, expectedBalance })
    if (r.balanceAfter != null) prevBalance = r.balanceAfter
  }
  return out
}

// Classifies a candidate row that shares a fingerprintExact with one or
// more other rows (`collisionRows` — same date, merchant, amount,
// direction, currency on the same account). `sourceType` is the payment
// account's sourceType ('bank' or 'credit_card') since the evidence
// available differs between the two per the accounting spec.
export function classifyFingerprintCollision(candidate, collisionRows, sourceType) {
  const evidence = {
    sameDate: true, // guaranteed by fingerprintExact already including the date
    sameAmount: true, // guaranteed by fingerprintExact already including the amount
    sameDescription: collisionRows.some(r => normalizeMerchant(r.merchantRaw) === normalizeMerchant(candidate.merchantRaw)),
    sameReference: null, // no reliable reference/authorization-number column is extracted from statements today
    balanceSequenceValid: candidate.balanceSequenceValid ?? null,
    sameSourceRow: collisionRows.some(r => r.rawRowText && candidate.rawRowText && r.rawRowText === candidate.rawRowText),
    statementTotalsConsistent: null, // statement-level opening/closing balance totals aren't parsed today
  }

  // The exact same source row appearing twice is the one case with genuine
  // "this looks like a repeated upload" evidence, regardless of statement
  // type — but it's still surfaced for review, never auto-deleted.
  if (evidence.sameSourceRow) {
    return {
      status: 'confirmed_duplicate',
      reason: 'Identical row text already imported on this account — this looks like a repeated upload of the same statement, not two separate transactions.',
      evidence,
    }
  }

  if (sourceType === 'bank') {
    if (evidence.balanceSequenceValid === true) {
      return {
        status: 'verified_separate',
        reason: 'Same date and amount detected, but the running balance confirms that these are separate transactions.',
        evidence,
      }
    }
    const balanceKnown = candidate.balanceAfter != null
    const distinctBalance = balanceKnown && !collisionRows.some(r => r.balanceAfter != null && r.balanceAfter === candidate.balanceAfter)
    if (distinctBalance) {
      return {
        status: 'verified_separate',
        reason: 'Same date and amount detected, but the balance after this transaction differs from the earlier one — the balance sequence confirms these are separate transactions.',
        evidence,
      }
    }
    if (!balanceKnown) {
      return {
        status: 'needs_review',
        reason: 'Same date and amount detected. No running balance was available on this row to confirm whether it is a separate transaction.',
        evidence,
      }
    }
    return {
      status: 'possible_duplicate',
      reason: 'Same date, amount, and reported running balance as an existing transaction on this account. This is not enough evidence to mark it as a confirmed duplicate — please review.',
      evidence,
    }
  }

  // Credit-card statements: no per-row running balance to lean on, so keep
  // both rows by default and use description as the next-best signal.
  if (!evidence.sameDescription) {
    return {
      status: 'verified_separate',
      reason: 'Same date and amount detected, but the merchant description differs — treated as separate transactions.',
      evidence,
    }
  }
  return {
    status: 'needs_review',
    reason: 'Same date, amount, and merchant description detected. Credit-card statements do not provide a running balance for this row, so both transactions have been retained pending review.',
    evidence,
  }
}

// ---- Statement-level totals validation -------------------------------------

// Independent, whole-statement sanity check on top of the per-row balance
// sequence: does opening balance + net movement of every parsed row equal
// the statement's own printed closing balance? This exists specifically to
// catch OUR parsing mistakes (a misread column, a dropped row, a sign
// error) rather than to second-guess the bank's own figures — the bank's
// own numbers are trusted; our extraction of them is what needs checking.
// Returns null (never a guess) when either balance figure wasn't found in
// the statement at all.
function rowSignature(r) {
  return [r.transactionDate, normalizeMerchant(r.merchantRaw), Number(r.settlementAmount).toFixed(2), r.direction].join('|')
}

// Multiset comparison between a fresh re-parse of the original statement
// file and whatever is actually stored as transactions for that import —
// the re-verification check for "does what's in the ledger still match the
// source document." A row present in one set but not (an available copy
// of) the other is counted, never assumed away. This is a re-check, not a
// duplicate check — two genuinely identical transactions in the same
// statement are expected to appear the same number of times on both sides
// and net out to zero here.
// A bare count of "N differ" isn't enough to act on — the caller (and
// whoever's staring at the mismatch badge) needs to see WHICH rows, or
// there's no way to tell a real gap from a rounding/normalization quirk
// in the comparison itself. Returns up to 20 examples of each side.
export function diffTransactionSets(reparsedRows, storedRows) {
  const counts = new Map()
  for (const r of storedRows) {
    const key = rowSignature(r)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  let missingFromRecords = 0
  const missingRows = []
  for (const r of reparsedRows) {
    const key = rowSignature(r)
    const n = counts.get(key) || 0
    if (n > 0) counts.set(key, n - 1)
    else {
      missingFromRecords++
      if (missingRows.length < 20) missingRows.push({ transactionDate: r.transactionDate, merchantRaw: r.merchantRaw, settlementAmount: r.settlementAmount, direction: r.direction })
    }
  }
  const extraInRecords = [...counts.values()].reduce((a, b) => a + b, 0)
  const extraRows = []
  for (const [key, n] of counts) {
    if (n <= 0) continue
    const [transactionDate, merchantNormalized, settlementAmount, direction] = key.split('|')
    for (let i = 0; i < n && extraRows.length < 20; i++) extraRows.push({ transactionDate, merchantRaw: merchantNormalized, settlementAmount: parseFloat(settlementAmount), direction })
  }
  return { missingFromRecords, extraInRecords, missingRows, extraRows }
}

export function validateStatementTotals({ openingBalance, closingBalance, rows, tolerance = 0.02 }) {
  if (openingBalance == null || closingBalance == null) return null
  const net = rows.reduce((sum, r) => sum + (r.direction === 'credit' ? r.settlementAmount : -r.settlementAmount), 0)
  const expectedClosingBalance = openingBalance + net
  const difference = closingBalance - expectedClosingBalance
  return {
    consistent: Math.abs(difference) <= tolerance,
    openingBalance,
    closingBalance,
    expectedClosingBalance,
    difference,
  }
}
