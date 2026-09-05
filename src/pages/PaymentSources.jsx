import { useState, useEffect, useRef, Fragment } from 'react'
import { collection, query, where, onSnapshot, addDoc, doc, deleteDoc, updateDoc, writeBatch, serverTimestamp, getDocs } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import ConfirmDialog from '../components/ConfirmDialog'
import { CURRENCIES } from '../constants'
import { parseCSV, mapCsvRecords, normalizeMerchant, classifyTransactionType, computeFingerprints } from '../lib/paymentMatching'
import { parsePdfStatement } from '../lib/pdfStatementParser'
import { uploadStatementFile, deleteStatementFile } from '../statementStorage'
import { annotateBalanceSequence, classifyFingerprintCollision, validateStatementTotals, diffTransactionSets, DUPLICATE_STATUS_LABELS } from '../lib/duplicateDetection'
import { MatchedIcon, WarningIcon, ICON_STROKE_WIDTH } from '../icons'

const SOURCE_TYPES = [
  { value: 'bank', label: 'Bank Account' },
  { value: 'credit_card', label: 'Credit Card' },
]

// A sequential batch (Verify All / Fix All Mismatches) awaits one fetch at
// a time — with no timeout, a single stalled request (slow cold start,
// dropped connection) hangs the whole batch indefinitely with no visible
// error, which looks exactly like "it fixes a few then just stops."
// Aborting after 30s turns that into a per-item failure the loop can move
// past, instead of a silent, unrecoverable stall.
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export default function PaymentSources() {
  const { activeProject } = useProject()
  const [accounts, setAccounts] = useState([])
  const [imports, setImports] = useState([])
  const [creating, setCreating] = useState(false)
  const [newAccount, setNewAccount] = useState({ label: '', sourceType: 'bank', accountTail: '', institutionName: '', settlementCurrency: 'HKD' })
  const [saving, setSaving] = useState(false)
  const [importAccountId, setImportAccountId] = useState('')
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  // PDF rows are heuristically parsed from table layout, unlike structured
  // CSV — they're held here for the user to review/exclude before anything
  // is written to Firestore.
  const [pdfPreview, setPdfPreview] = useState(null) // { fileName, rows: [{...row, include}] }
  // Remaining PDFs from a batch selection, reviewed one at a time — each
  // PDF's rows are heuristically parsed and must be checked before write,
  // so a batch can't just import every PDF's rows unattended.
  const [pdfQueue, setPdfQueue] = useState([])
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [verifyingImportId, setVerifyingImportId] = useState(null)
  const [verifyingAll, setVerifyingAll] = useState(false)
  const [fixingAll, setFixingAll] = useState(false)
  const [verifyMsg, setVerifyMsg] = useState('')
  // Transactions for whichever import the user has expanded to review/edit.
  const [viewingImportId, setViewingImportId] = useState(null)
  const [importTxns, setImportTxns] = useState([])
  const [editTxnId, setEditTxnId] = useState(null)
  const [editTxnData, setEditTxnData] = useState({})
  const fileRef = useRef()
  const attachFileRef = useRef()
  const attachingImportRef = useRef(null)
  const [attachingImportId, setAttachingImportId] = useState(null)

  useEffect(() => {
    if (!activeProject) return
    const unsubA = onSnapshot(
      query(collection(db, 'paymentAccounts'), where('userId', '==', auth.currentUser.uid), where('projectId', '==', activeProject.id)),
      snap => setAccounts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubI = onSnapshot(
      query(collection(db, 'paymentImports'), where('userId', '==', auth.currentUser.uid), where('projectId', '==', activeProject.id)),
      // Grouped by filename (then real-data-first within a group) rather than
      // plain creation order — a failed/duplicate re-import of the same
      // statement creates a second row with the same name, and sorting
      // purely by createdAt scatters it far from the original, making it
      // easy to attach a file or take an action on the wrong one (verified:
      // this happened in practice).
      snap => setImports(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) =>
        (a.sourceFileName || '').localeCompare(b.sourceFileName || '') || (b.lineCount || 0) - (a.lineCount || 0)
      ))
    )
    return () => { unsubA(); unsubI() }
  }, [activeProject?.id])

  useEffect(() => {
    if (!viewingImportId) { setImportTxns([]); return }
    const unsub = onSnapshot(
      query(collection(db, 'paymentTransactions'), where('userId', '==', auth.currentUser.uid), where('importId', '==', viewingImportId)),
      snap => setImportTxns(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.transactionDate || '').localeCompare(b.transactionDate || '')))
    )
    return unsub
  }, [viewingImportId])

  async function createAccount() {
    if (!newAccount.label.trim()) return
    setSaving(true)
    await addDoc(collection(db, 'paymentAccounts'), {
      ...newAccount,
      label: newAccount.label.trim(),
      accountTail: newAccount.accountTail.trim() || null,
      institutionName: newAccount.institutionName.trim() || null,
      userId: auth.currentUser.uid,
      projectId: activeProject.id,
      active: true,
      createdAt: serverTimestamp(),
    })
    setNewAccount({ label: '', sourceType: 'bank', accountTail: '', institutionName: '', settlementCurrency: 'HKD' })
    setCreating(false)
    setSaving(false)
  }

  // Shared write path for both CSV (trusted, structured) and confirmed PDF
  // rows (reviewed by the user first). Classifies, fingerprints against
  // existing transactions on this account, and writes paymentImports +
  // paymentTransactions.
  //
  // `reprocessImportId`, when given, means this is a re-parse of an
  // ALREADY-stored file (see reprocessFromStoredPdf) — the bank's PDF is
  // trusted; a mismatch found by Verify Against PDF means OUR parsing was
  // wrong, not the source document. Rather than making the user delete and
  // re-upload from their computer, this replaces the existing import's
  // transactions in place: same import record, same stored file, freshly
  // parsed rows.
  async function commitRows(mapped, account, file, sourceType, statementTotals, reprocessImportId) {
    let importRef
    if (reprocessImportId) {
      importRef = doc(db, 'paymentImports', reprocessImportId)
      const oldSnap = await getDocs(query(
        collection(db, 'paymentTransactions'),
        where('userId', '==', auth.currentUser.uid),
        where('importId', '==', reprocessImportId)
      ))
      for (const d of oldSnap.docs) await unlinkTransaction({ id: d.id, ...d.data() })
      for (let i = 0; i < oldSnap.docs.length; i += 400) {
        const batch = writeBatch(db)
        oldSnap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref))
        await batch.commit()
      }
      await updateDoc(importRef, {
        periodStart: mapped.reduce((min, t) => !min || (t.transactionDate && t.transactionDate < min) ? t.transactionDate : min, null),
        periodEnd: mapped.reduce((max, t) => !max || (t.transactionDate && t.transactionDate > max) ? t.transactionDate : max, null),
        importStatus: 'processing',
        lineCount: mapped.length,
        updatedAt: serverTimestamp(),
        errorMessage: null,
        openingBalance: statementTotals?.openingBalance ?? null,
        closingBalance: statementTotals?.closingBalance ?? null,
        totalsCheck: null,
        verification: null,
      })
    } else {
      importRef = await addDoc(collection(db, 'paymentImports'), {
        userId: auth.currentUser.uid,
        projectId: activeProject.id,
        paymentAccountId: account.id,
        sourceType,
        sourceFileName: file.name,
        sourceFileUrl: null,
        sourceFilePath: null,
        periodStart: mapped.reduce((min, t) => !min || (t.transactionDate && t.transactionDate < min) ? t.transactionDate : min, null),
        periodEnd: mapped.reduce((max, t) => !max || (t.transactionDate && t.transactionDate > max) ? t.transactionDate : max, null),
        importStatus: 'processing',
        lineCount: mapped.length,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        errorMessage: null,
        openingBalance: statementTotals?.openingBalance ?? null,
        closingBalance: statementTotals?.closingBalance ?? null,
        totalsCheck: null,
        verification: null,
      })

      // Keep the original statement file — the transaction rows are derived
      // data, and proper accounting practice keeps the source document
      // retrievable for audit trail, the same way receipts are kept for
      // expenses. Uploaded as-is (no compression/re-encoding). Skipped on
      // reprocess: the file is already stored and unchanged.
      try {
        const { url, path } = await uploadStatementFile(file, auth.currentUser.uid, importRef.id)
        await updateDoc(doc(db, 'paymentImports', importRef.id), { sourceFileUrl: url, sourceFilePath: path })
      } catch (err) {
        console.error('Failed to store original statement file:', err.message)
      }
    }

    // Check existing rows sharing a fingerprint on this account, so a
    // re-imported statement (or a genuine same-day repeat transaction,
    // which fingerprints identically) can be told apart per the accounting
    // rule: same date + same amount alone is never enough evidence to call
    // something a confirmed duplicate. See src/lib/duplicateDetection.js.
    const existingSnap = await getDocs(query(
      collection(db, 'paymentTransactions'),
      where('userId', '==', auth.currentUser.uid),
      where('paymentAccountId', '==', account.id)
    ))
    const existingByFingerprint = new Map()
    for (const d of existingSnap.docs) {
      const data = d.data()
      const list = existingByFingerprint.get(data.fingerprintExact) || []
      list.push({ id: d.id, rawRowText: data.rawRowText, balanceAfter: data.balanceAfter, merchantRaw: data.merchantRaw })
      existingByFingerprint.set(data.fingerprintExact, list)
    }

    // From here on, a thrown error (a bad field value Firestore rejects, a
    // network drop mid-batch, anything) must never leave the import stuck
    // at importStatus:'processing' forever with a lineCount that claims
    // rows exist when the write never actually landed — that produces
    // exactly the "did this actually work?" confusion this is guarding
    // against. Anything that fails here marks the import 'error' with a
    // visible reason instead of silently going quiet.
    try {

    // Validates each row's printed balance against the previous row's
    // balance plus this row's own credit/debit, in the statement's own
    // original order — never re-sorted by date, since two same-day rows
    // must keep their printed sequence to be checked correctly.
    const sequenced = annotateBalanceSequence(mapped)

    const rowsToWrite = []
    const counts = { verified_separate: 0, possible_duplicate: 0, confirmed_duplicate: 0, needs_review: 0 }
    for (const t of sequenced) {
      const merchantNormalized = normalizeMerchant(t.merchantRaw)
      const transactionType = classifyTransactionType(t.merchantRaw, t.direction)
      const { fingerprintExact, fingerprintLoose } = await computeFingerprints({
        projectId: activeProject.id,
        accountId: account.id,
        transactionDate: t.transactionDate,
        merchantNormalized,
        settlementAmount: t.settlementAmount,
        direction: t.direction,
        settlementCurrency: account.settlementCurrency,
      })

      // Collision rows = anything already on this account, or an earlier
      // row already staged in this very batch, sharing the same exact
      // fingerprint — a fresh statement can contain its own genuine
      // same-day repeats before anything is written at all.
      const collisionRows = existingByFingerprint.get(fingerprintExact) || []
      let duplicateStatus = null, duplicateReason = null, duplicateEvidence = null, duplicateOfTransactionId = null
      if (collisionRows.length) {
        const result = classifyFingerprintCollision(t, collisionRows, account.sourceType)
        duplicateStatus = result.status
        duplicateReason = result.reason
        duplicateEvidence = result.evidence
        // collisionRows[0] may be another row from THIS SAME batch, not yet
        // written to Firestore — it has no .id yet (only existing on-disk
        // rows get one, added in the map's initial population below). Firestore
        // rejects `undefined` outright, so this must fall back to null, never
        // leave the field as whatever collisionRows[0].id happens to be.
        if (collisionRows.length === 1 && result.status !== 'verified_separate') duplicateOfTransactionId = collisionRows[0].id || null
      }

      const rowDoc = {
        userId: auth.currentUser.uid,
        projectId: activeProject.id,
        importId: importRef.id,
        paymentAccountId: account.id,
        transactionDate: t.transactionDate,
        postDate: t.postDate,
        rawDateText: t.rawDateText,
        merchantRaw: t.merchantRaw,
        merchantNormalized,
        settlementAmount: t.settlementAmount,
        settlementCurrency: account.settlementCurrency,
        direction: t.direction,
        transactionType,
        balanceAfter: t.balanceAfter ?? null,
        installmentIndicator: false,
        installmentNumber: null,
        installmentTotal: null,
        pendingOrPosted: 'posted',
        fingerprintExact,
        fingerprintLoose,
        // Every row is written — a duplicate warning is metadata for
        // review, never a reason to silently drop a real transaction.
        status: 'unmatched',
        matchedExpenseIds: [],
        settlementGroupId: null,
        confidenceScore: null,
        matchReasons: [],
        sourceRowIndex: t.sourceRowIndex,
        rawRowText: t.rawRowText,
        duplicateStatus,
        duplicateReason,
        duplicateEvidence,
        duplicateOfTransactionId,
        duplicateReviewedBy: null,
        duplicateReviewedAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }
      if (duplicateStatus) counts[duplicateStatus]++
      // Add this row itself to the collision pool so a later row in the
      // same batch sees it too (e.g. a third same-day repeat).
      existingByFingerprint.set(fingerprintExact, [...collisionRows, { rawRowText: t.rawRowText, balanceAfter: t.balanceAfter, merchantRaw: t.merchantRaw }])
      rowsToWrite.push(rowDoc)
    }

    for (let i = 0; i < rowsToWrite.length; i += 400) {
      const batch = writeBatch(db)
      rowsToWrite.slice(i, i + 400).forEach(row => batch.set(doc(collection(db, 'paymentTransactions')), row))
      await batch.commit()
    }

    // Independent whole-statement check: does opening balance + net of every
    // written row equal the statement's own printed closing balance? This
    // exists to catch OUR parsing mistakes, not the bank's figures — see
    // validateStatementTotals in duplicateDetection.js.
    const totalsCheck = statementTotals
      ? validateStatementTotals({ openingBalance: statementTotals.openingBalance, closingBalance: statementTotals.closingBalance, rows: rowsToWrite })
      : null

    await updateDoc(doc(db, 'paymentImports', importRef.id), {
      importStatus: 'ready',
      lineCount: rowsToWrite.length,
      totalsCheck,
      updatedAt: serverTimestamp(),
    })

    return { written: rowsToWrite.length, flagged: counts.possible_duplicate + counts.confirmed_duplicate + counts.needs_review, counts, totalsCheck, importId: importRef.id }

    } catch (err) {
      await updateDoc(doc(db, 'paymentImports', importRef.id), {
        importStatus: 'error',
        errorMessage: err.message || 'unknown error',
        updatedAt: serverTimestamp(),
      }).catch(() => {}) // best-effort — the original error is what matters below
      throw err
    }
  }

  // Resolves a duplicate warning without ever deleting the transaction.
  // 'confirmed_duplicate' additionally excludes it from active
  // reconciliation (status: 'ignored') since the user has explicitly
  // confirmed it's a repeat — the row itself, its OCR text, and its
  // statement link are all preserved either way.
  async function resolveDuplicate(txn, newStatus) {
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      duplicateStatus: newStatus,
      duplicateReviewedBy: auth.currentUser.email,
      duplicateReviewedAt: serverTimestamp(),
      ...(newStatus === 'confirmed_duplicate' ? { status: 'ignored' } : {}),
      updatedAt: serverTimestamp(),
    })
    setBusyId(null)
  }

  function dismissDuplicateWarning(txn) {
    setBusyId(txn.id)
    updateDoc(doc(db, 'paymentTransactions', txn.id), {
      duplicateReviewedBy: auth.currentUser.email,
      duplicateReviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }).finally(() => setBusyId(null))
  }

  // Re-checks an already-imported PDF statement against its own stored
  // source file — re-parsing it from scratch and comparing the result to
  // what's actually recorded as transactions. This is the "did we parse
  // this correctly" audit, independent of and re-runnable any time after
  // the original manual review — a parser fix (or a manual edit/delete
  // made afterward) can only be caught by re-checking, not by trusting the
  // one-time import review forever. CSV imports are skipped: their parsing
  // is a direct structured mapping, not the heuristic table-layout guessing
  // a PDF import depends on, so there's nothing here for it to catch.
  async function verifyImportAgainstSource(imp) {
    if (imp.sourceType !== 'pdf' || !imp.sourceFileUrl) return null
    setVerifyingImportId(imp.id)
    try {
      // Firebase Storage download URLs don't allow a direct cross-origin
      // fetch() from the browser (same reason receipts are downloaded
      // through /api/download-receipt, not fetched directly) — route
      // through the same Netlify edge-function proxy.
      const resp = await fetchWithTimeout('/api/download-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: imp.sourceFileUrl }),
      })
      if (!resp.ok) throw new Error(`could not re-fetch the stored file (HTTP ${resp.status})`)
      const blob = await resp.blob()
      const { rows: reparsedRows, openingBalance, closingBalance } = await parsePdfStatement(blob)

      const storedSnap = await getDocs(query(
        collection(db, 'paymentTransactions'),
        where('userId', '==', auth.currentUser.uid),
        where('importId', '==', imp.id)
      ))
      const storedRows = storedSnap.docs.map(d => d.data())

      const { missingFromRecords, extraInRecords, missingRows, extraRows } = diffTransactionSets(reparsedRows, storedRows)
      const totalsCheck = validateStatementTotals({ openingBalance, closingBalance, rows: reparsedRows })
      const consistent = missingFromRecords === 0 && extraInRecords === 0 && (totalsCheck === null || totalsCheck.consistent)

      const verification = {
        verifiedAt: serverTimestamp(),
        reparsedCount: reparsedRows.length,
        storedCount: storedRows.length,
        missingFromRecords,
        extraInRecords,
        missingRows,
        extraRows,
        totalsCheck,
        consistent,
      }
      await updateDoc(doc(db, 'paymentImports', imp.id), { verification })
      return { ...verification, fileName: imp.sourceFileName }
    } catch (err) {
      const verification = { verifiedAt: serverTimestamp(), error: err.message || 'unknown error', consistent: false }
      await updateDoc(doc(db, 'paymentImports', imp.id), { verification })
      return { ...verification, fileName: imp.sourceFileName }
    } finally {
      setVerifyingImportId(null)
    }
  }

  async function verifyAllImports() {
    const eligible = imports.filter(imp => imp.sourceType === 'pdf' && imp.sourceFileUrl)
    if (!eligible.length) {
      setVerifyMsg('No PDF imports with a stored original file to verify.')
      return
    }
    setVerifyingAll(true)
    setVerifyMsg(`Verifying 0 of ${eligible.length}…`)
    let mismatches = 0
    for (let i = 0; i < eligible.length; i++) {
      setVerifyMsg(`Verifying ${i + 1} of ${eligible.length}…`)
      const result = await verifyImportAgainstSource(eligible[i])
      if (result && !result.consistent) mismatches++
    }
    setVerifyMsg(
      mismatches === 0
        ? `Verified ${eligible.length} statement${eligible.length === 1 ? '' : 's'} against their original PDFs — all match.`
        : `Verified ${eligible.length} statement${eligible.length === 1 ? '' : 's'} — ${mismatches} need review (see the Mismatch badge next to each import below).`
    )
    setVerifyingAll(false)
  }

  // Bulk version of "Fix from Stored PDF" (below), for when a batch of
  // statements imported under an earlier parser version all come back
  // mismatched at once. Only auto-commits a re-parse when its OWN
  // statement-totals check comes back clean — that's independent evidence
  // (from the bank's own printed opening/closing balance) the new parse is
  // actually correct, not just different. Anything without that evidence
  // (no printed balance to check, or the fresh parse still doesn't
  // reconcile) is left exactly as-is for manual "Fix from Stored PDF"
  // review — this never silently overwrites a transaction record without
  // a reason to trust the replacement more than what's already there.
  async function fixAllMismatches() {
    const eligible = imports.filter(imp => imp.sourceType === 'pdf' && imp.sourceFileUrl && imp.verification && !imp.verification.error && !imp.verification.consistent)
    if (!eligible.length) {
      setVerifyMsg('No mismatched imports to fix.')
      return
    }
    setFixingAll(true)
    let fixed = 0, leftForReview = 0, failed = 0
    for (let i = 0; i < eligible.length; i++) {
      const imp = eligible[i]
      setVerifyMsg(`Checking ${i + 1} of ${eligible.length} mismatched statements…`)
      try {
        const resp = await fetchWithTimeout('/api/download-receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: imp.sourceFileUrl }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const blob = await resp.blob()
        const file = new File([blob], imp.sourceFileName || 'statement.pdf', { type: blob.type })
        const { rows, openingBalance, closingBalance } = await parsePdfStatement(file)
        if (!rows.length) { leftForReview++; continue }
        const totalsCheck = validateStatementTotals({ openingBalance, closingBalance, rows })
        if (totalsCheck && totalsCheck.consistent) {
          const account = accounts.find(a => a.id === imp.paymentAccountId)
          await commitRows(rows, account, file, 'pdf', { openingBalance, closingBalance }, imp.id)
          await verifyImportAgainstSource({ ...imp, sourceFileName: imp.sourceFileName })
          fixed++
        } else {
          leftForReview++
        }
      } catch (err) {
        failed++
      }
    }
    setVerifyMsg(
      `Auto-fixed ${fixed} of ${eligible.length} mismatched statement${eligible.length === 1 ? '' : 's'} (confirmed against their own printed balance).` +
      (leftForReview ? ` ${leftForReview} still need manual review via "Fix from Stored PDF" — no clean totals check to confirm the re-parse.` : '') +
      (failed ? ` ${failed} couldn't be re-fetched.` : '')
    )
    setFixingAll(false)
  }

  // Editing or deleting a transaction that's already confirmed against an
  // expense (or linked as a card-payment/bank-debit settlement) would
  // otherwise leave that link pointing at stale or missing data. This
  // reverts both sides of the link before the transaction itself changes.
  async function unlinkTransaction(txn) {
    if (txn.matchedExpenseIds?.[0]) {
      await updateDoc(doc(db, 'expenses', txn.matchedExpenseIds[0]), {
        matchedPaymentTransactionId: null,
        matchedPaymentAccountId: null,
        settlementAmount: null,
        settlementCurrency: null,
        settlementStatus: 'unsettled',
      })
    }
    if (txn.settlementGroupId) {
      const partnerSnap = await getDocs(query(
        collection(db, 'paymentTransactions'),
        where('userId', '==', auth.currentUser.uid),
        where('settlementGroupId', '==', txn.settlementGroupId)
      ))
      for (const d of partnerSnap.docs) {
        if (d.id === txn.id) continue
        await updateDoc(doc(db, 'paymentTransactions', d.id), { settlementGroupId: null, status: 'unmatched' })
      }
    }
  }

  function startEditTxn(txn) {
    setEditTxnId(txn.id)
    setEditTxnData({ transactionDate: txn.transactionDate || '', merchantRaw: txn.merchantRaw, settlementAmount: txn.settlementAmount, direction: txn.direction })
  }

  async function saveEditTxn(txn) {
    if (!editTxnData.transactionDate || !(parseFloat(editTxnData.settlementAmount) > 0)) {
      alert('A transaction date and an amount greater than 0 are required.')
      return
    }
    const merchantRaw = editTxnData.merchantRaw.trim()
    const merchantNormalized = normalizeMerchant(merchantRaw)
    const transactionType = classifyTransactionType(merchantRaw, editTxnData.direction)
    const account = accounts.find(a => a.id === txn.paymentAccountId)
    const { fingerprintExact, fingerprintLoose } = await computeFingerprints({
      projectId: activeProject.id,
      accountId: txn.paymentAccountId,
      transactionDate: editTxnData.transactionDate,
      merchantNormalized,
      settlementAmount: parseFloat(editTxnData.settlementAmount),
      direction: editTxnData.direction,
      settlementCurrency: account?.settlementCurrency || txn.settlementCurrency,
    })
    if (txn.status === 'matched' || txn.settlementGroupId) await unlinkTransaction(txn)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      transactionDate: editTxnData.transactionDate,
      merchantRaw,
      merchantNormalized,
      settlementAmount: parseFloat(editTxnData.settlementAmount) || 0,
      direction: editTxnData.direction,
      transactionType,
      fingerprintExact,
      fingerprintLoose,
      status: 'unmatched',
      matchedExpenseIds: [],
      settlementGroupId: null,
      confidenceScore: null,
      matchReasons: [],
      updatedAt: serverTimestamp(),
    })
    setEditTxnId(null)
  }

  function deleteTxn(txn) {
    setConfirmDialog({
      message: `Delete this transaction (${txn.merchantRaw})? This cannot be undone.`,
      onConfirm: async () => {
        await unlinkTransaction(txn)
        await deleteDoc(doc(db, 'paymentTransactions', txn.id))
        setConfirmDialog(null)
      },
    })
  }

  function deleteImport(imp) {
    setConfirmDialog({
      message: `Delete "${imp.sourceFileName}" and all ${imp.lineCount} transaction${imp.lineCount === 1 ? '' : 's'} it imported? This cannot be undone.`,
      onConfirm: async () => {
        const snap = await getDocs(query(
          collection(db, 'paymentTransactions'),
          where('userId', '==', auth.currentUser.uid),
          where('importId', '==', imp.id)
        ))
        for (const d of snap.docs) await unlinkTransaction({ id: d.id, ...d.data() })
        for (let i = 0; i < snap.docs.length; i += 400) {
          const batch = writeBatch(db)
          snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref))
          await batch.commit()
        }
        if (imp.sourceFilePath) {
          try { await deleteStatementFile(imp.sourceFilePath) } catch (err) { console.error('Failed to delete stored statement file:', err.message) }
        }
        await deleteDoc(doc(db, 'paymentImports', imp.id))
        if (viewingImportId === imp.id) setViewingImportId(null)
        setConfirmDialog(null)
      },
    })
  }

  // Backfills the original file onto an import made before source-file
  // storage existed (or where the upload failed at import time).
  function openAttachOriginal(imp) {
    attachingImportRef.current = imp
    setAttachingImportId(imp.id)
    attachFileRef.current.click()
  }

  async function handleAttachOriginal(e) {
    const file = e.target.files[0]
    e.target.value = ''
    const imp = attachingImportRef.current
    if (!file || !imp) return
    try {
      const { url, path } = await uploadStatementFile(file, auth.currentUser.uid, imp.id)
      await updateDoc(doc(db, 'paymentImports', imp.id), { sourceFileUrl: url, sourceFilePath: path })
    } catch (err) {
      alert('Failed to attach file: ' + (err.message || 'unknown error'))
    }
    setAttachingImportId(null)
  }

  // Parses one PDF and either shows it for review or, if nothing came out
  // of it, records why and moves on to the next queued file.
  async function loadPdfPreview(file, accountId, remainingQueue) {
    setImporting(true)
    try {
      const { rows, lineCount, pageCount, openingBalance, closingBalance } = await parsePdfStatement(file)
      if (!rows.length) {
        setImportMsg(prev => (prev ? prev + ' ' : '') + `${file.name}: ` + (
          lineCount === 0
            ? 'no text found — it may be a scanned image rather than a digital statement. Try exporting a CSV from your bank instead.'
            : `found ${lineCount} lines across ${pageCount} page(s) but couldn't recognize any transaction rows — this bank's PDF layout may not be supported yet. Try CSV export instead.`
        ))
        setImporting(false)
        await advancePdfQueue(remainingQueue, accountId)
        return
      }
      // Checked against the FULL parsed set, before the user excludes
      // anything — this is a signal of whether OUR extraction of this PDF
      // is correct, independent of what gets committed.
      const totalsCheck = validateStatementTotals({ openingBalance, closingBalance, rows })
      setPdfPreview({ file, fileName: file.name, accountId, openingBalance, closingBalance, totalsCheck, rows: rows.map(r => ({ ...r, include: true })) })
      setPdfQueue(remainingQueue)
    } catch (err) {
      setImportMsg(prev => (prev ? prev + ' ' : '') + `${file.name}: could not read PDF — ${err.message || 'unknown error'}`)
      setImporting(false)
      await advancePdfQueue(remainingQueue, accountId)
      return
    }
    setImporting(false)
  }

  async function advancePdfQueue(queue, accountId) {
    if (!queue.length) { setPdfQueue([]); setPdfPreview(null); return }
    const [next, ...rest] = queue
    await loadPdfPreview(next, accountId, rest)
  }

  async function handleFileSelected(e) {
    const files = Array.from(e.target.files)
    e.target.value = ''
    if (!files.length || !importAccountId) return
    const account = accounts.find(a => a.id === importAccountId)
    const pdfFiles = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    const csvFiles = files.filter(f => !pdfFiles.includes(f))

    setImporting(true)
    setImportMsg('')
    const messages = []
    for (const file of csvFiles) {
      try {
        const text = await file.text()
        const { headers, records } = parseCSV(text)
        const mapped = mapCsvRecords(records, headers)
        if (!mapped.length) {
          messages.push(`${file.name}: no transaction rows recognized — check it has Date, Description, and Amount (or Debit/Credit) columns.`)
          continue
        }
        const { written, flagged } = await commitRows(mapped, account, file, 'csv')
        messages.push(
          `${file.name}: imported ${written} transaction${written === 1 ? '' : 's'}` +
          (flagged ? ` (${flagged} flagged for duplicate review — see View/Edit below)` : '') + '.'
        )
      } catch (err) {
        messages.push(`${file.name}: import failed — ${err.message || 'unknown error'}`)
      }
    }
    if (csvFiles.length) messages.push('Go to Reconciliation to review matches.')
    setImportMsg(messages.join(' '))
    setImporting(false)

    if (pdfFiles.length) await advancePdfQueue(pdfFiles, account.id)
  }

  function togglePreviewRow(i) {
    setPdfPreview(prev => ({ ...prev, rows: prev.rows.map((r, idx) => idx === i ? { ...r, include: !r.include } : r) }))
  }

  async function confirmPdfImport() {
    const account = accounts.find(a => a.id === pdfPreview.accountId)
    const toImport = pdfPreview.rows.filter(r => r.include)
    const accountId = pdfPreview.accountId
    const queueAfter = pdfQueue
    const reprocessImportId = pdfPreview.reprocessImportId || null
    setImporting(true)
    try {
      const { written, flagged } = await commitRows(toImport, account, pdfPreview.file, 'pdf', {
        openingBalance: pdfPreview.openingBalance,
        closingBalance: pdfPreview.closingBalance,
      }, reprocessImportId)
      let recheckNote = ''
      // Re-verify immediately so the Mismatch badge clears (or shows what,
      // if anything, is still off) without a separate manual step — and say
      // so explicitly, rather than leaving the user to guess whether the
      // fix actually landed by re-reading a badge that might not have
      // refreshed yet.
      if (reprocessImportId) {
        const imp = imports.find(i => i.id === reprocessImportId)
        if (imp) {
          const result = await verifyImportAgainstSource({ ...imp, sourceFileName: pdfPreview.fileName })
          recheckNote = result?.consistent
            ? ' Re-checked: now matches the PDF.'
            : result?.error
              ? ` Re-checked: couldn't confirm (${result.error}).`
              : ` Re-checked: still ${(result?.missingFromRecords || 0) + (result?.extraInRecords || 0)} row(s) differ — see the Mismatch details below.`
        }
        // Open the transaction list for this import right away — the whole
        // point of "Fix from Stored PDF" is replacing what's on record, and
        // the only way to actually see that happened is to look at it, not
        // just read a success message.
        setViewingImportId(reprocessImportId)
      }
      setImportMsg(prev => (prev ? prev + ' ' : '') +
        (reprocessImportId
          ? `${pdfPreview.fileName}: re-processed from the stored PDF — ${written} transaction${written === 1 ? '' : 's'} now on record`
          : `${pdfPreview.fileName}: imported ${written} transaction${written === 1 ? '' : 's'} from PDF`) +
        (flagged ? ` (${flagged} flagged for duplicate review — see View/Edit below)` : '') +
        (reprocessImportId ? recheckNote : ' Go to Reconciliation to review matches.')
      )
    } catch (err) {
      setImportMsg(prev => (prev ? prev + ' ' : '') + `${pdfPreview.fileName}: ${reprocessImportId ? 're-processing' : 'import'} failed — ${err.message || 'unknown error'}`)
    }
    setImporting(false)
    await advancePdfQueue(queueAfter, accountId)
  }

  // One-click fix for a "Verify Against PDF" mismatch: the bank's PDF is
  // trusted, so a mismatch means OUR parsing was wrong — re-fetches the
  // ALREADY-stored original file (no re-upload from the user's computer)
  // and shows it in the normal review screen, tagged so confirming it
  // replaces this import's transactions in place instead of creating a
  // second, duplicate import.
  async function reprocessFromStoredPdf(imp) {
    if (!imp.sourceFileUrl) return
    setImporting(true)
    setImportMsg('')
    try {
      const resp = await fetchWithTimeout('/api/download-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: imp.sourceFileUrl }),
      })
      if (!resp.ok) throw new Error(`could not re-fetch the stored file (HTTP ${resp.status})`)
      const blob = await resp.blob()
      const file = new File([blob], imp.sourceFileName || 'statement.pdf', { type: blob.type })
      const { rows, lineCount, pageCount, openingBalance, closingBalance } = await parsePdfStatement(file)
      if (!rows.length) {
        setImportMsg(`${imp.sourceFileName}: re-parsing the stored PDF found ${lineCount === 0 ? 'no text' : `${lineCount} lines across ${pageCount} page(s) but no recognizable transaction rows`} — this can't be auto-fixed. Try Delete and a manual re-upload instead.`)
        setImporting(false)
        return
      }
      const totalsCheck = validateStatementTotals({ openingBalance, closingBalance, rows })
      setPdfPreview({
        file, fileName: imp.sourceFileName, accountId: imp.paymentAccountId,
        openingBalance, closingBalance, totalsCheck,
        rows: rows.map(r => ({ ...r, include: true })),
        reprocessImportId: imp.id,
      })
    } catch (err) {
      setImportMsg(`${imp.sourceFileName}: could not re-fetch the stored PDF — ${err.message || 'unknown error'}`)
    }
    setImporting(false)
  }

  function skipPdfPreview() {
    advancePdfQueue(pdfQueue, pdfPreview.accountId)
  }

  if (!activeProject) return <div className="page"><p className="loading">Loading…</p></div>

  return (
    <div className="page">
      <ProjectBanner />
      <h2>Payment Sources</h2>

      <div className="card">
        <div className="card-header">
          <h3>Accounts</h3>
          {!creating && <button className="btn-ghost btn-small" onClick={() => setCreating(true)}>+ Add Account</button>}
        </div>

        {accounts.length === 0 && !creating && <p className="empty">No payment accounts yet — add one to start importing statements.</p>}

        <div className="project-list">
          {accounts.map(a => (
            <div key={a.id} className="project-card">
              <div className="project-card-main">
                <span className="badge badge-office">{SOURCE_TYPES.find(s => s.value === a.sourceType)?.label}</span>
                <span className="project-card-name">{a.label}{a.accountTail ? ` ****${a.accountTail}` : ''}</span>
                <span className="hint">{a.settlementCurrency}</span>
              </div>
            </div>
          ))}
        </div>

        {creating && (
          <div className="project-create-form">
            <input
              className="project-name-input"
              placeholder="Label, e.g. HSBC Visa ****1234"
              value={newAccount.label}
              onChange={e => setNewAccount({ ...newAccount, label: e.target.value })}
              autoFocus
            />
            <div className="filter-row" style={{ marginTop: 10 }}>
              <select value={newAccount.sourceType} onChange={e => setNewAccount({ ...newAccount, sourceType: e.target.value })}>
                {SOURCE_TYPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <input
                placeholder="Institution (optional)"
                value={newAccount.institutionName}
                onChange={e => setNewAccount({ ...newAccount, institutionName: e.target.value })}
              />
              <input
                placeholder="Last 4 digits (optional)"
                maxLength={4}
                value={newAccount.accountTail}
                onChange={e => setNewAccount({ ...newAccount, accountTail: e.target.value.replace(/\D/g, '') })}
              />
              <select value={newAccount.settlementCurrency} onChange={e => setNewAccount({ ...newAccount, settlementCurrency: e.target.value })}>
                {CURRENCIES.filter(c => c !== 'Other').map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="project-card-actions" style={{ marginTop: 10 }}>
              <button onClick={createAccount} disabled={saving || !newAccount.label.trim()} className="btn-primary">Create</button>
              <button onClick={() => setCreating(false)} className="btn-ghost">Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Import Statement</h3>
        {accounts.length === 0 ? (
          <p className="hint">Add a payment account first.</p>
        ) : (
          <>
            <div className="filter-row">
              <select value={importAccountId} onChange={e => setImportAccountId(e.target.value)}>
                <option value="">Select account…</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
              <button
                className="btn-primary"
                disabled={!importAccountId || importing}
                onClick={() => fileRef.current.click()}
              >
                {importing ? 'Reading…' : '+ Import Statements'}
              </button>
              <input type="file" multiple accept=".csv,.pdf,text/csv,application/pdf" hidden ref={fileRef} onChange={handleFileSelected} />
              <input type="file" accept=".csv,.pdf,text/csv,application/pdf" hidden ref={attachFileRef} onChange={handleAttachOriginal} />
            </div>
            <p className="hint">Select multiple CSV/PDF files at once for a batch import. CSV needs Date, Description, and Amount columns (or separate Debit/Credit). PDF must be a digital statement (not a scanned image) — each PDF's parsed rows are shown for review before import, one file at a time.</p>
            {importMsg && <p className={/import failed|could not read|no text found|couldn't recognize/i.test(importMsg) ? 'error-msg' : 'success-msg'}>{importMsg}</p>}
          </>
        )}

        {pdfPreview && (
          <div className="card" style={{ marginTop: 16, background: '#fafbfc' }}>
            <div className="card-header">
              <h3>Review parsed rows — {pdfPreview.fileName}</h3>
              <span className="hint">{pdfPreview.rows.filter(r => r.include).length} of {pdfPreview.rows.length} selected</span>
            </div>
            <p className="hint">
              PDF table parsing is heuristic — uncheck any row that looks wrong before importing.
              {pdfQueue.length > 0 && ` ${pdfQueue.length} more PDF${pdfQueue.length === 1 ? '' : 's'} queued after this one.`}
            </p>
            {pdfPreview.totalsCheck && (
              <p className={pdfPreview.totalsCheck.consistent ? 'success-msg' : 'error-msg'}>
                {pdfPreview.totalsCheck.consistent
                  ? `Statement totals check passed: opening ${pdfPreview.totalsCheck.openingBalance.toFixed(2)} + these transactions = closing ${pdfPreview.totalsCheck.closingBalance.toFixed(2)}, as printed on the statement.`
                  : `Statement totals check FAILED: opening ${pdfPreview.totalsCheck.openingBalance.toFixed(2)} + these transactions should total ${pdfPreview.totalsCheck.expectedClosingBalance.toFixed(2)}, but the statement prints closing ${pdfPreview.totalsCheck.closingBalance.toFixed(2)} (difference ${pdfPreview.totalsCheck.difference.toFixed(2)}). This usually means a row was missed or misread — check carefully before importing.`}
              </p>
            )}
            <div className="table-wrap">
              <table className="expense-table">
                <thead>
                  <tr><th></th><th>Date</th><th>Description</th><th>Amount</th><th>Direction</th><th>Balance</th></tr>
                </thead>
                <tbody>
                  {pdfPreview.rows.map((r, i) => (
                    <tr key={i} style={{ opacity: r.include ? 1 : 0.4 }}>
                      <td><input type="checkbox" checked={r.include} onChange={() => togglePreviewRow(i)} /></td>
                      <td>{r.transactionDate}</td>
                      <td>{r.merchantRaw}</td>
                      <td>{r.settlementAmount.toFixed(2)}</td>
                      <td>{r.direction}</td>
                      <td>{r.balanceAfter != null ? r.balanceAfter.toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="action-row" style={{ marginTop: 12 }}>
              <button className="btn-primary" disabled={importing || !pdfPreview.rows.some(r => r.include)} onClick={confirmPdfImport}>
                {importing ? 'Importing…' : `Import ${pdfPreview.rows.filter(r => r.include).length} Row(s)`}
              </button>
              <button className="btn-ghost" disabled={importing} onClick={skipPdfPreview}>{pdfQueue.length > 0 ? 'Skip' : 'Cancel'}</button>
            </div>
          </div>
        )}

        {imports.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="action-row" style={{ alignItems: 'center' }}>
              <button className="btn-primary btn-small" disabled={verifyingAll || fixingAll || verifyingImportId} onClick={verifyAllImports}>
                {verifyingAll ? 'Verifying…' : 'Verify All Against PDFs'}
              </button>
              <button className="btn-ghost btn-small" disabled={verifyingAll || fixingAll || verifyingImportId} onClick={fixAllMismatches}>
                {fixingAll ? 'Fixing…' : 'Fix All Mismatches'}
              </button>
              {verifyMsg && <span className="hint">{verifyMsg}</span>}
            </div>
            <p className="hint">
              Re-parses each PDF import's stored original file from scratch and checks it against what's recorded — catches a misread row or a parser fix that changes results, independent of the one-time review at import.
              "Fix All Mismatches" only auto-replaces a statement's transactions when the fresh re-parse's own printed balance confirms it's correct — anything less certain is left for manual review below.
            </p>
          <div className="table-wrap">
            <table className="expense-table">
              <thead>
                <tr><th>File</th><th>Account</th><th>Period</th><th>Rows</th><th>Status</th><th>Verified</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {imports.map(imp => (
                  <Fragment key={imp.id}>
                    <tr style={imp.lineCount === 0 ? { opacity: 0.55 } : undefined}>
                      <td>{imp.sourceFileName}{imp.lineCount === 0 && <span className="hint"> (empty — safe to delete)</span>}</td>
                      <td>{accounts.find(a => a.id === imp.paymentAccountId)?.label || '—'}</td>
                      <td>{imp.periodStart && imp.periodEnd ? `${imp.periodStart} – ${imp.periodEnd}` : '—'}</td>
                      <td>{imp.lineCount}</td>
                      <td>
                        {imp.importStatus}
                        {imp.importStatus === 'error' && imp.errorMessage && (
                          <div className="hint" style={{ maxWidth: 160 }}>{imp.errorMessage}</div>
                        )}
                      </td>
                      <td style={{ minWidth: 220 }}>
                        {/* Fixed min-height regardless of content, so a check landing
                            mid-list (Verify All runs them one at a time) doesn't grow
                            this row and shove every row below it up/down while
                            scrolling — the "bouncing" the badge text used to cause. */}
                        <div style={{ minHeight: 40 }}>
                          {imp.sourceType !== 'pdf' ? '—' : !imp.verification ? (
                            <span className="hint">Not yet checked</span>
                          ) : imp.verification.error ? (
                            <>
                              <span className="badge badge-warning"><WarningIcon size={12} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" /> Couldn't re-check</span>
                              <div className="hint" style={{ maxWidth: 220 }}>{imp.verification.error}</div>
                            </>
                          ) : imp.verification.consistent ? (
                            <span className="badge badge-office" title="Re-parsed statement matches the stored transactions and totals."><MatchedIcon size={12} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" /> Verified</span>
                          ) : (
                            <>
                              <span className="badge badge-warning"><WarningIcon size={12} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" /> Mismatch</span>
                              <div className="hint" style={{ maxWidth: 220 }}>
                                {[
                                  imp.verification.missingFromRecords ? `${imp.verification.missingFromRecords} row(s) in the PDF not found in records` : null,
                                  imp.verification.extraInRecords ? `${imp.verification.extraInRecords} recorded row(s) not found in the PDF` : null,
                                  imp.verification.totalsCheck && !imp.verification.totalsCheck.consistent
                                    ? `Totals mismatch: expected closing ${imp.verification.totalsCheck.expectedClosingBalance.toFixed(2)}, statement shows ${imp.verification.totalsCheck.closingBalance.toFixed(2)}`
                                    : null,
                                ].filter(Boolean).join(' · ')}
                              </div>
                              {(imp.verification.missingRows?.length > 0 || imp.verification.extraRows?.length > 0) && (
                                <details style={{ marginTop: 4 }}>
                                  <summary className="hint" style={{ cursor: 'pointer' }}>Show which rows differ</summary>
                                  {imp.verification.missingRows?.length > 0 && (
                                    <div className="hint" style={{ maxWidth: 260, marginTop: 4 }}>
                                      <strong>In the PDF, not in records:</strong>
                                      {imp.verification.missingRows.map((r, i) => (
                                        <div key={i}>{r.transactionDate} · {r.merchantRaw} · {r.settlementAmount?.toFixed?.(2) ?? r.settlementAmount} · {r.direction}</div>
                                      ))}
                                    </div>
                                  )}
                                  {imp.verification.extraRows?.length > 0 && (
                                    <div className="hint" style={{ maxWidth: 260, marginTop: 4 }}>
                                      <strong>In records, not in the PDF:</strong>
                                      {imp.verification.extraRows.map((r, i) => (
                                        <div key={i}>{r.transactionDate} · {r.merchantRaw} · {r.settlementAmount?.toFixed?.(2) ?? r.settlementAmount} · {r.direction}</div>
                                      ))}
                                    </div>
                                  )}
                                </details>
                              )}
                              <button className="btn-small" style={{ marginTop: 4 }} disabled={importing || fixingAll || verifyingAll} onClick={() => reprocessFromStoredPdf(imp)}>
                                Fix from Stored PDF
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                      <td style={{ minWidth: 150 }}>
                        <button className="btn-small" onClick={() => setViewingImportId(viewingImportId === imp.id ? null : imp.id)}>
                          {viewingImportId === imp.id ? 'Hide' : 'View/Edit'}
                        </button>
                        {imp.sourceFileUrl
                          ? <a href={imp.sourceFileUrl} target="_blank" rel="noreferrer" className="btn-small">Original</a>
                          : <button className="btn-small" disabled={attachingImportId === imp.id} onClick={() => openAttachOriginal(imp)}>
                              {attachingImportId === imp.id ? 'Uploading…' : 'Attach Original'}
                            </button>}
                        {imp.sourceType === 'pdf' && imp.sourceFileUrl && (
                          <button className="btn-small" style={{ minWidth: 130, display: 'inline-block' }} disabled={verifyingImportId === imp.id || verifyingAll || fixingAll} onClick={() => verifyImportAgainstSource(imp)}>
                            {verifyingImportId === imp.id ? 'Checking…' : 'Verify Against PDF'}
                          </button>
                        )}
                        <button className="btn-small btn-danger" onClick={() => deleteImport(imp)}>Delete</button>
                      </td>
                    </tr>
                    {viewingImportId === imp.id && (
                      <tr key={imp.id + '-txns'}>
                        <td colSpan={7} style={{ background: '#fafbfc' }}>
                          {importTxns.length === 0 ? <p className="empty" style={{ margin: '8px 0' }}>No transactions in this import.</p> : (
                            <table className="expense-table" style={{ margin: '8px 0' }}>
                              <thead>
                                <tr><th>Date</th><th>Description</th><th>Amount</th><th>Direction</th><th>Balance</th><th>Type</th><th>Duplicate</th><th>Actions</th></tr>
                              </thead>
                              <tbody>
                                {importTxns.map(txn => (
                                  <tr key={txn.id}>
                                    {editTxnId === txn.id ? (
                                      <>
                                        <td><input type="date" value={editTxnData.transactionDate} onChange={e => setEditTxnData({ ...editTxnData, transactionDate: e.target.value })} /></td>
                                        <td><input value={editTxnData.merchantRaw} onChange={e => setEditTxnData({ ...editTxnData, merchantRaw: e.target.value })} /></td>
                                        <td><input type="number" inputMode="decimal" min="0" step="0.01" value={editTxnData.settlementAmount} onChange={e => setEditTxnData({ ...editTxnData, settlementAmount: e.target.value })} /></td>
                                        <td>
                                          <select value={editTxnData.direction} onChange={e => setEditTxnData({ ...editTxnData, direction: e.target.value })}>
                                            <option value="debit">debit</option>
                                            <option value="credit">credit</option>
                                          </select>
                                        </td>
                                        <td>{txn.balanceAfter != null ? txn.balanceAfter.toFixed(2) : '—'}</td>
                                        <td>{txn.transactionType}</td>
                                        <td>—</td>
                                        <td>
                                          <button className="btn-small" onClick={() => saveEditTxn(txn)}>Save</button>
                                          <button className="btn-small btn-ghost" onClick={() => setEditTxnId(null)}>Cancel</button>
                                        </td>
                                      </>
                                    ) : (
                                      <>
                                        <td>{txn.transactionDate}</td>
                                        <td>{txn.merchantRaw}</td>
                                        <td>{txn.settlementAmount?.toFixed(2)}</td>
                                        <td>{txn.direction}</td>
                                        <td>{txn.balanceAfter != null ? txn.balanceAfter.toFixed(2) : '—'}</td>
                                        <td>{txn.transactionType}{txn.status === 'matched' && ' · matched'}{txn.settlementGroupId && ' · linked'}</td>
                                        <td>
                                          {txn.duplicateStatus ? (
                                            <>
                                              <span
                                                className={`badge ${txn.duplicateStatus === 'verified_separate' ? 'badge-office' : txn.duplicateStatus === 'confirmed_duplicate' ? 'badge-bank-charges' : 'badge-warning'}`}
                                                title={txn.duplicateReason || ''}
                                              >
                                                {DUPLICATE_STATUS_LABELS[txn.duplicateStatus] || txn.duplicateStatus}
                                              </span>
                                              {txn.duplicateReason && <div className="hint" style={{ maxWidth: 220 }}>{txn.duplicateReason}</div>}
                                              {!['verified_separate', 'confirmed_duplicate'].includes(txn.duplicateStatus) && (
                                                <div style={{ marginTop: 4 }}>
                                                  <button className="btn-small" disabled={busyId === txn.id} onClick={() => resolveDuplicate(txn, 'verified_separate')}>Keep as Separate</button>
                                                  <button className="btn-small btn-danger" disabled={busyId === txn.id} onClick={() => resolveDuplicate(txn, 'confirmed_duplicate')}>Confirm Duplicate</button>
                                                  {!txn.duplicateReviewedAt && (
                                                    <button className="btn-small btn-ghost" disabled={busyId === txn.id} onClick={() => dismissDuplicateWarning(txn)}>Ignore Warning</button>
                                                  )}
                                                  {imp.sourceFileUrl && (
                                                    <a href={imp.sourceFileUrl} target="_blank" rel="noreferrer" className="btn-small btn-ghost">Open Source Row</a>
                                                  )}
                                                </div>
                                              )}
                                            </>
                                          ) : '—'}
                                        </td>
                                        <td>
                                          <button className="btn-small" onClick={() => startEditTxn(txn)}>Edit</button>
                                          <button className="btn-small btn-danger" onClick={() => deleteTxn(txn)}>Delete</button>
                                        </td>
                                      </>
                                    )}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        )}
      </div>

      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  )
}
