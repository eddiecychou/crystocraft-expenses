import { useState, useEffect, useRef } from 'react'
import { collection, query, where, onSnapshot, addDoc, doc, updateDoc, writeBatch, serverTimestamp, getDocs } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import { CURRENCIES } from '../constants'
import { parseCSV, mapCsvRecords, normalizeMerchant, classifyTransactionType, computeFingerprints } from '../lib/paymentMatching'

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

  async function handleImport(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file || !importAccountId) return
    const account = accounts.find(a => a.id === importAccountId)
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

      const importRef = await addDoc(collection(db, 'paymentImports'), {
        userId: auth.currentUser.uid,
        projectId: activeProject.id,
        paymentAccountId: account.id,
        sourceType: 'csv',
        sourceFileName: file.name,
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

      setImportMsg(
        `Imported ${rowsToWrite.length} transaction${rowsToWrite.length === 1 ? '' : 's'}` +
        (dupCount ? ` (${dupCount} duplicate${dupCount === 1 ? '' : 's'} skipped)` : '') +
        '. Go to Reconciliation to review matches.'
      )
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
                {importing ? 'Importing…' : '+ Import CSV'}
              </button>
              <input type="file" accept=".csv,text/csv" hidden ref={fileRef} onChange={handleImport} />
            </div>
            <p className="hint">CSV must have Date, Description, and Amount columns (or separate Debit/Credit columns).</p>
            {importMsg && <p className={importMsg.startsWith('Import failed') ? 'error-msg' : 'success-msg'}>{importMsg}</p>}
          </>
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
