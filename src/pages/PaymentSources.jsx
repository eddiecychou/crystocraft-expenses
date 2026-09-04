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

const SOURCE_TYPES = [
  { value: 'bank', label: 'Bank Account' },
  { value: 'credit_card', label: 'Credit Card' },
]

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
  // Rows whose fingerprint matched an existing transaction on this account.
  // Held here for review instead of silently dropped — a genuine repeat
  // transaction (same merchant/amount/day, e.g. two identical purchases)
  // fingerprints identically to a re-imported duplicate, so the system
  // can't safely decide on its own; the user can.
  const [duplicateReview, setDuplicateReview] = useState(null) // { importId, fileName, rows: [{...doc, include}] }
  const [confirmDialog, setConfirmDialog] = useState(null)
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
      snap => setImports(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)))
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
  async function commitRows(mapped, account, file, sourceType) {
    const importRef = await addDoc(collection(db, 'paymentImports'), {
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
    })

    // Keep the original statement file — the transaction rows are derived
    // data, and proper accounting practice keeps the source document
    // retrievable for audit trail, the same way receipts are kept for
    // expenses. Uploaded as-is (no compression/re-encoding).
    try {
      const { url, path } = await uploadStatementFile(file, auth.currentUser.uid, importRef.id)
      await updateDoc(doc(db, 'paymentImports', importRef.id), { sourceFileUrl: url, sourceFilePath: path })
    } catch (err) {
      console.error('Failed to store original statement file:', err.message)
    }

    // Check existing fingerprints for this account so re-importing the same
    // statement flags duplicates instead of silently doubling transactions.
    const existingSnap = await getDocs(query(
      collection(db, 'paymentTransactions'),
      where('userId', '==', auth.currentUser.uid),
      where('paymentAccountId', '==', account.id)
    ))
    const existingFingerprints = new Set(existingSnap.docs.map(d => d.data().fingerprintExact))

    // Rows whose fingerprint matches something already imported on this
    // account aren't written automatically — a genuine repeat transaction
    // (same merchant/amount/date, e.g. two identical purchases) produces
    // the exact same fingerprint as a re-imported duplicate, so this can't
    // be decided silently. They're returned separately for the caller to
    // put in front of the user instead.
    const rowsToWrite = []
    const duplicateRows = []
    for (const t of mapped) {
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
        installmentIndicator: false,
        installmentNumber: null,
        installmentTotal: null,
        pendingOrPosted: 'posted',
        fingerprintExact,
        fingerprintLoose,
        status: 'unmatched',
        matchedExpenseIds: [],
        settlementGroupId: null,
        confidenceScore: null,
        matchReasons: [],
        sourceRowIndex: t.sourceRowIndex,
        rawRowText: t.rawRowText,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }
      if (existingFingerprints.has(fingerprintExact)) { duplicateRows.push(rowDoc); continue }
      existingFingerprints.add(fingerprintExact)
      rowsToWrite.push(rowDoc)
    }

    for (let i = 0; i < rowsToWrite.length; i += 400) {
      const batch = writeBatch(db)
      rowsToWrite.slice(i, i + 400).forEach(row => batch.set(doc(collection(db, 'paymentTransactions')), row))
      await batch.commit()
    }

    await updateDoc(doc(db, 'paymentImports', importRef.id), {
      importStatus: 'ready',
      lineCount: rowsToWrite.length,
      updatedAt: serverTimestamp(),
    })

    return { written: rowsToWrite.length, duplicateRows, importId: importRef.id }
  }

  // Writes duplicate-fingerprint rows the user has explicitly confirmed are
  // genuine (not a re-import) after reviewing them.
  async function confirmDuplicateImport() {
    const toWrite = duplicateReview.rows.filter(r => r.include)
    setImporting(true)
    try {
      for (let i = 0; i < toWrite.length; i += 400) {
        const batch = writeBatch(db)
        toWrite.slice(i, i + 400).forEach(({ include, ...row }) => batch.set(doc(collection(db, 'paymentTransactions')), row))
        await batch.commit()
      }
      const impSnap = imports.find(imp => imp.id === duplicateReview.importId)
      await updateDoc(doc(db, 'paymentImports', duplicateReview.importId), {
        lineCount: (impSnap?.lineCount || 0) + toWrite.length,
        updatedAt: serverTimestamp(),
      })
      setImportMsg(prev => prev + (toWrite.length ? ` ${toWrite.length} reviewed duplicate${toWrite.length === 1 ? '' : 's'} added.` : ''))
      setDuplicateReview(null)
    } catch (err) {
      setImportMsg('Failed to import reviewed duplicates: ' + (err.message || 'unknown error'))
    }
    setImporting(false)
  }

  function toggleDuplicateRow(i) {
    setDuplicateReview(prev => ({ ...prev, rows: prev.rows.map((r, idx) => idx === i ? { ...r, include: !r.include } : r) }))
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

  async function handleFileSelected(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file || !importAccountId) return
    const account = accounts.find(a => a.id === importAccountId)
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

    if (isPdf) {
      setImporting(true)
      setImportMsg('')
      try {
        const { rows, lineCount, pageCount } = await parsePdfStatement(file)
        if (!rows.length) {
          setImportMsg(
            lineCount === 0
              ? 'No text found in this PDF — it may be a scanned image rather than a digital statement. Try exporting a CSV from your bank instead.'
              : `Found ${lineCount} lines of text across ${pageCount} page(s) but couldn't recognize any transaction rows — this bank's PDF layout may not be supported yet. Try CSV export instead.`
          )
        } else {
          setPdfPreview({ file, fileName: file.name, accountId: account.id, rows: rows.map(r => ({ ...r, include: true })) })
        }
      } catch (err) {
        setImportMsg('Could not read PDF: ' + (err.message || 'unknown error'))
      }
      setImporting(false)
      return
    }

    setImporting(true)
    setImportMsg('')
    try {
      const text = await file.text()
      const { headers, records } = parseCSV(text)
      const mapped = mapCsvRecords(records, headers)
      if (!mapped.length) {
        setImportMsg('No transaction rows recognized in this CSV — check it has Date, Description, and Amount (or Debit/Credit) columns.')
        setImporting(false)
        return
      }
      const { written, duplicateRows, importId } = await commitRows(mapped, account, file, 'csv')
      setImportMsg(
        `Imported ${written} transaction${written === 1 ? '' : 's'}` +
        (duplicateRows.length ? ` (${duplicateRows.length} possible duplicate${duplicateRows.length === 1 ? '' : 's'} held for review below)` : '') +
        '. Go to Reconciliation to review matches.'
      )
      if (duplicateRows.length) setDuplicateReview({ importId, fileName: file.name, rows: duplicateRows.map(r => ({ ...r, include: false })) })
    } catch (err) {
      setImportMsg('Import failed: ' + (err.message || 'unknown error'))
    }
    setImporting(false)
  }

  function togglePreviewRow(i) {
    setPdfPreview(prev => ({ ...prev, rows: prev.rows.map((r, idx) => idx === i ? { ...r, include: !r.include } : r) }))
  }

  async function confirmPdfImport() {
    const account = accounts.find(a => a.id === pdfPreview.accountId)
    const toImport = pdfPreview.rows.filter(r => r.include)
    setImporting(true)
    setImportMsg('')
    try {
      const { written, duplicateRows, importId } = await commitRows(toImport, account, pdfPreview.file, 'pdf')
      setImportMsg(
        `Imported ${written} transaction${written === 1 ? '' : 's'} from PDF` +
        (duplicateRows.length ? ` (${duplicateRows.length} possible duplicate${duplicateRows.length === 1 ? '' : 's'} held for review below)` : '') +
        '. Go to Reconciliation to review matches.'
      )
      if (duplicateRows.length) setDuplicateReview({ importId, fileName: pdfPreview.fileName, rows: duplicateRows.map(r => ({ ...r, include: false })) })
      setPdfPreview(null)
    } catch (err) {
      setImportMsg('Import failed: ' + (err.message || 'unknown error'))
    }
    setImporting(false)
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
                {importing ? 'Reading…' : '+ Import CSV or PDF'}
              </button>
              <input type="file" accept=".csv,.pdf,text/csv,application/pdf" hidden ref={fileRef} onChange={handleFileSelected} />
              <input type="file" accept=".csv,.pdf,text/csv,application/pdf" hidden ref={attachFileRef} onChange={handleAttachOriginal} />
            </div>
            <p className="hint">CSV needs Date, Description, and Amount columns (or separate Debit/Credit). PDF must be a digital statement (not a scanned image) — parsed rows are shown for review before import.</p>
            {importMsg && <p className={importMsg.startsWith('Import failed') || importMsg.startsWith('Could not') || importMsg.startsWith('No text') || importMsg.startsWith('Found') ? 'error-msg' : 'success-msg'}>{importMsg}</p>}
          </>
        )}

        {pdfPreview && (
          <div className="card" style={{ marginTop: 16, background: '#fafbfc' }}>
            <div className="card-header">
              <h3>Review parsed rows — {pdfPreview.fileName}</h3>
              <span className="hint">{pdfPreview.rows.filter(r => r.include).length} of {pdfPreview.rows.length} selected</span>
            </div>
            <p className="hint">PDF table parsing is heuristic — uncheck any row that looks wrong before importing.</p>
            <div className="table-wrap">
              <table className="expense-table">
                <thead>
                  <tr><th></th><th>Date</th><th>Description</th><th>Amount</th><th>Direction</th></tr>
                </thead>
                <tbody>
                  {pdfPreview.rows.map((r, i) => (
                    <tr key={i} style={{ opacity: r.include ? 1 : 0.4 }}>
                      <td><input type="checkbox" checked={r.include} onChange={() => togglePreviewRow(i)} /></td>
                      <td>{r.transactionDate}</td>
                      <td>{r.merchantRaw}</td>
                      <td>{r.settlementAmount.toFixed(2)}</td>
                      <td>{r.direction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="action-row" style={{ marginTop: 12 }}>
              <button className="btn-primary" disabled={importing || !pdfPreview.rows.some(r => r.include)} onClick={confirmPdfImport}>
                {importing ? 'Importing…' : `Import ${pdfPreview.rows.filter(r => r.include).length} Row(s)`}
              </button>
              <button className="btn-ghost" disabled={importing} onClick={() => setPdfPreview(null)}>Cancel</button>
            </div>
          </div>
        )}

        {duplicateReview && (
          <div className="card" style={{ marginTop: 16, background: '#fffaf0' }}>
            <div className="card-header">
              <h3>Possible Duplicates — {duplicateReview.fileName}</h3>
              <span className="hint">{duplicateReview.rows.filter(r => r.include).length} of {duplicateReview.rows.length} selected</span>
            </div>
            <p className="hint">
              These rows match the date, amount, and description of a transaction already imported on this account.
              That usually means the statement overlaps one already imported — but if these are genuinely separate
              transactions (e.g. two identical purchases on the same day), check the ones to add.
            </p>
            <div className="table-wrap">
              <table className="expense-table">
                <thead>
                  <tr><th></th><th>Date</th><th>Description</th><th>Amount</th><th>Direction</th></tr>
                </thead>
                <tbody>
                  {duplicateReview.rows.map((r, i) => (
                    <tr key={i} style={{ opacity: r.include ? 1 : 0.6 }}>
                      <td><input type="checkbox" checked={r.include} onChange={() => toggleDuplicateRow(i)} /></td>
                      <td>{r.transactionDate}</td>
                      <td>{r.merchantRaw}</td>
                      <td>{r.settlementAmount.toFixed(2)}</td>
                      <td>{r.direction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="action-row" style={{ marginTop: 12 }}>
              <button className="btn-primary" disabled={importing || !duplicateReview.rows.some(r => r.include)} onClick={confirmDuplicateImport}>
                {importing ? 'Importing…' : `Add ${duplicateReview.rows.filter(r => r.include).length} as New`}
              </button>
              <button className="btn-ghost" disabled={importing} onClick={() => setDuplicateReview(null)}>Discard All as Duplicates</button>
            </div>
          </div>
        )}

        {imports.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="expense-table">
              <thead>
                <tr><th>File</th><th>Account</th><th>Period</th><th>Rows</th><th>Status</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {imports.map(imp => (
                  <Fragment key={imp.id}>
                    <tr>
                      <td>{imp.sourceFileName}</td>
                      <td>{accounts.find(a => a.id === imp.paymentAccountId)?.label || '—'}</td>
                      <td>{imp.periodStart && imp.periodEnd ? `${imp.periodStart} – ${imp.periodEnd}` : '—'}</td>
                      <td>{imp.lineCount}</td>
                      <td>{imp.importStatus}</td>
                      <td>
                        <button className="btn-small" onClick={() => setViewingImportId(viewingImportId === imp.id ? null : imp.id)}>
                          {viewingImportId === imp.id ? 'Hide' : 'View/Edit'}
                        </button>
                        {imp.sourceFileUrl
                          ? <a href={imp.sourceFileUrl} target="_blank" rel="noreferrer" className="btn-small">Original</a>
                          : <button className="btn-small" disabled={attachingImportId === imp.id} onClick={() => openAttachOriginal(imp)}>
                              {attachingImportId === imp.id ? 'Uploading…' : 'Attach Original'}
                            </button>}
                        <button className="btn-small btn-danger" onClick={() => deleteImport(imp)}>Delete</button>
                      </td>
                    </tr>
                    {viewingImportId === imp.id && (
                      <tr key={imp.id + '-txns'}>
                        <td colSpan={6} style={{ background: '#fafbfc' }}>
                          {importTxns.length === 0 ? <p className="empty" style={{ margin: '8px 0' }}>No transactions in this import.</p> : (
                            <table className="expense-table" style={{ margin: '8px 0' }}>
                              <thead>
                                <tr><th>Date</th><th>Description</th><th>Amount</th><th>Direction</th><th>Type</th><th>Actions</th></tr>
                              </thead>
                              <tbody>
                                {importTxns.map(txn => (
                                  <tr key={txn.id}>
                                    {editTxnId === txn.id ? (
                                      <>
                                        <td><input type="date" value={editTxnData.transactionDate} onChange={e => setEditTxnData({ ...editTxnData, transactionDate: e.target.value })} /></td>
                                        <td><input value={editTxnData.merchantRaw} onChange={e => setEditTxnData({ ...editTxnData, merchantRaw: e.target.value })} /></td>
                                        <td><input type="number" min="0" step="0.01" value={editTxnData.settlementAmount} onChange={e => setEditTxnData({ ...editTxnData, settlementAmount: e.target.value })} /></td>
                                        <td>
                                          <select value={editTxnData.direction} onChange={e => setEditTxnData({ ...editTxnData, direction: e.target.value })}>
                                            <option value="debit">debit</option>
                                            <option value="credit">credit</option>
                                          </select>
                                        </td>
                                        <td>{txn.transactionType}</td>
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
                                        <td>{txn.transactionType}{txn.status === 'matched' && ' · matched'}{txn.settlementGroupId && ' · linked'}</td>
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
