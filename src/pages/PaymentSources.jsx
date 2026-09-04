import { useState, useEffect, useRef } from 'react'
import { collection, query, where, onSnapshot, addDoc, doc, updateDoc, writeBatch, serverTimestamp, getDocs } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import { CURRENCIES } from '../constants'
import { parseCSV, mapCsvRecords, normalizeMerchant, classifyTransactionType, computeFingerprints } from '../lib/paymentMatching'
import { parsePdfStatement } from '../lib/pdfStatementParser'

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
  const fileRef = useRef()

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
  async function commitRows(mapped, account, fileName, sourceType) {
    const importRef = await addDoc(collection(db, 'paymentImports'), {
      userId: auth.currentUser.uid,
      projectId: activeProject.id,
      paymentAccountId: account.id,
      sourceType,
      sourceFileName: fileName,
      sourceFileUrl: null,
      periodStart: mapped.reduce((min, t) => !min || (t.transactionDate && t.transactionDate < min) ? t.transactionDate : min, null),
      periodEnd: mapped.reduce((max, t) => !max || (t.transactionDate && t.transactionDate > max) ? t.transactionDate : max, null),
      importStatus: 'processing',
      lineCount: mapped.length,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      errorMessage: null,
    })

    // Check existing fingerprints for this account so re-importing the same
    // statement flags duplicates instead of silently doubling transactions.
    const existingSnap = await getDocs(query(
      collection(db, 'paymentTransactions'),
      where('userId', '==', auth.currentUser.uid),
      where('paymentAccountId', '==', account.id)
    ))
    const existingFingerprints = new Set(existingSnap.docs.map(d => d.data().fingerprintExact))

    let dupCount = 0
    const rowsToWrite = []
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
      if (existingFingerprints.has(fingerprintExact)) { dupCount++; continue }
      existingFingerprints.add(fingerprintExact)
      rowsToWrite.push({
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
      })
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

    return { written: rowsToWrite.length, dupCount }
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
          setPdfPreview({ fileName: file.name, accountId: account.id, rows: rows.map(r => ({ ...r, include: true })) })
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
      const { written, dupCount } = await commitRows(mapped, account, file.name, 'csv')
      setImportMsg(
        `Imported ${written} transaction${written === 1 ? '' : 's'}` +
        (dupCount ? ` (${dupCount} duplicate${dupCount === 1 ? '' : 's'} skipped)` : '') +
        '. Go to Reconciliation to review matches.'
      )
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
      const { written, dupCount } = await commitRows(toImport, account, pdfPreview.fileName, 'pdf')
      setImportMsg(
        `Imported ${written} transaction${written === 1 ? '' : 's'} from PDF` +
        (dupCount ? ` (${dupCount} duplicate${dupCount === 1 ? '' : 's'} skipped)` : '') +
        '. Go to Reconciliation to review matches.'
      )
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

        {imports.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="expense-table">
              <thead>
                <tr><th>File</th><th>Account</th><th>Period</th><th>Rows</th><th>Status</th></tr>
              </thead>
              <tbody>
                {imports.map(imp => (
                  <tr key={imp.id}>
                    <td>{imp.sourceFileName}</td>
                    <td>{accounts.find(a => a.id === imp.paymentAccountId)?.label || '—'}</td>
                    <td>{imp.periodStart && imp.periodEnd ? `${imp.periodStart} – ${imp.periodEnd}` : '—'}</td>
                    <td>{imp.lineCount}</td>
                    <td>{imp.importStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
