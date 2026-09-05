import { useState, useEffect } from 'react'
import { collection, query, where, onSnapshot, doc, setDoc, deleteDoc, updateDoc, addDoc, writeBatch, serverTimestamp } from 'firebase/firestore'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { db, auth } from '../firebase'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import ConfirmDialog from '../components/ConfirmDialog'
import { CLASSIFICATION_LABELS, BUSINESS_PURPOSE_OPTIONS, merchantRuleDocId, computeVisibleToMembers } from '../lib/expenseClassification'
import { CREATE_EXPENSE_BLOCKED_TYPES } from '../lib/paymentMatching'
import { paymentTransactionsQuery } from '../lib/projectAccess'
import { parsePdfStatement } from '../lib/pdfStatementParser'
import { maskPdfPages } from '../lib/pdfRedaction'

// Statuses excluded from a Company Package export unless explicitly opted
// into — per spec §10/acceptance-criterion 11, Personal and Rejected never
// leave the app by default.
const EXPORTABLE_CLASSIFICATIONS = ['company_candidate', 'company_confirmed', 'shared', 'needs_accountant_review']

function toCsv(headers, rows) {
  const esc = v => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n')
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const CLASSIFICATION_BADGE_CLASS = {
  personal: 'badge-other',
  company_candidate: 'badge-office',
  company_confirmed: 'badge-success',
  shared: 'badge-warning',
  needs_accountant_review: 'badge-info',
  rejected_company_claim: 'badge-danger',
}

// Firestore 'in' queries cap at 10 values — chunk personal account ids so
// this still works once someone has more than 10 personal accounts, rather
// than silently dropping transactions past the 10th.
function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export default function CompanyReview() {
  const { activeProject } = useProject()
  const [accounts, setAccounts] = useState([])
  const [transactions, setTransactions] = useState([])
  const [rules, setRules] = useState([])
  const [imports, setImports] = useState([])
  const [expenses, setExpenses] = useState([])
  const [expandedMerchant, setExpandedMerchant] = useState(null)
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [purposeDraft, setPurposeDraft] = useState({}) // { [txnId]: { option, note } }
  const [exportModal, setExportModal] = useState(null) // { period, include: { [classification]: bool } }
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')

  useEffect(() => {
    if (!activeProject) return
    const unsub = onSnapshot(
      query(collection(db, 'paymentAccounts'), where('projectId', '==', activeProject.id)),
      snap => setAccounts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    return unsub
  }, [activeProject?.id])

  useEffect(() => {
    if (!activeProject) return
    const unsub = onSnapshot(
      query(collection(db, 'merchantRules'), where('projectId', '==', activeProject.id)),
      snap => setRules(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.merchantKey || '').localeCompare(b.merchantKey || '')))
    )
    return unsub
  }, [activeProject?.id])

  useEffect(() => {
    if (!activeProject) return
    const unsubImports = onSnapshot(
      query(collection(db, 'paymentImports'), where('projectId', '==', activeProject.id)),
      snap => setImports(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubExpenses = onSnapshot(
      query(collection(db, 'expenses'), where('projectId', '==', activeProject.id)),
      snap => setExpenses(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    return () => { unsubImports(); unsubExpenses() }
  }, [activeProject?.id])

  const personalAccountIds = accounts.filter(a => a.ownershipType === 'personal').map(a => a.id)

  // Re-subscribes per chunk of personal account ids and merges results —
  // only classified rows (personal accounts) ever carry a `classification`
  // field, so company-account transactions never appear here at all. A
  // non-owner collaborator's query also filters to visibleToMembers, so
  // unclassified/personal rows never reach this page for them at all.
  useEffect(() => {
    if (personalAccountIds.length === 0) { setTransactions([]); return }
    const chunks = chunk(personalAccountIds, 10)
    const byChunk = new Array(chunks.length).fill([])
    // projectId must be pinned by this query's own where() clause, not just
    // true in practice — see LESSONS_LEARNED.md / the expense-ops-center
    // skill on why an unconstrained cross-document get() in the security
    // rule otherwise gets the whole list request denied outright.
    const unsubs = chunks.map((ids, i) => onSnapshot(
      paymentTransactionsQuery(query(collection(db, 'paymentTransactions'), where('projectId', '==', activeProject.id), where('paymentAccountId', 'in', ids)), activeProject, auth.currentUser.uid),
      snap => {
        byChunk[i] = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        setTransactions(byChunk.flat())
      }
    ))
    return () => unsubs.forEach(u => u())
  }, [personalAccountIds.join(',')])

  const classified = transactions.filter(t => t.classification)

  const summary = {
    company_candidate: classified.filter(t => t.classification === 'company_candidate').length,
    personal: classified.filter(t => t.classification === 'personal').length,
    needs_accountant_review: classified.filter(t => t.classification === 'needs_accountant_review').length,
    missing_receipt: classified.filter(t => t.classification === 'company_candidate' && t.status !== 'matched').length,
  }

  const groups = Object.values(
    classified.reduce((acc, t) => {
      const key = t.merchantNormalized || t.merchantRaw || '(unknown)'
      if (!acc[key]) acc[key] = { key, merchant: t.merchantRaw, txns: [] }
      acc[key].txns.push(t)
      return acc
    }, {})
  ).sort((a, b) => b.txns.length - a.txns.length)

  function accountOf(id) { return accounts.find(a => a.id === id) }

  async function applyClassificationToGroup(group, classification, { saveRule = false } = {}) {
    const ids = group.txns.map(t => t.id)
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db)
      ids.slice(i, i + 400).forEach(id => batch.update(doc(db, 'paymentTransactions', id), {
        classification,
        classificationSource: 'user',
        suggestedClassification: null,
        visibleToMembers: computeVisibleToMembers(classification),
        updatedAt: serverTimestamp(),
      }))
      await batch.commit()
    }
    if (saveRule) {
      const merchantKey = group.txns[0]?.merchantNormalized
      if (merchantKey) {
        // Upserts one rule per (project, merchant) — re-confirming the same
        // merchant later updates the existing rule rather than piling up
        // duplicates. Saved as a SUGGESTION only (autoApprove: false) — per
        // spec §7, future imports never auto-classify from this merchant
        // until the user explicitly turns Auto-Approve on below.
        await setDoc(doc(db, 'merchantRules', merchantRuleDocId(activeProject.id, merchantKey)), {
          userId: auth.currentUser.uid,
          projectId: activeProject.id,
          merchantKey,
          merchantLabel: group.merchant,
          classification,
          confidence: 0.95,
          autoApprove: false,
          source: 'user_confirmed',
          lastConfirmedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
        }, { merge: true })
      }
    }
    setConfirmDialog(null)
  }

  function confirmGroupAction(group, classification, label) {
    const total = group.txns.reduce((s, t) => s + (t.settlementAmount || 0), 0)
    const summary = (
      <>
        You are about to update {group.txns.length} transaction{group.txns.length === 1 ? '' : 's'}:<br />
        Merchant: {group.merchant}<br />
        Classification: {label}<br />
        Estimated total: {group.txns[0]?.settlementCurrency || ''} {total.toFixed(2)}
      </>
    )
    setConfirmDialog({
      message: summary,
      confirmLabel: `Apply to These Only`,
      confirmClassName: 'btn-primary',
      onConfirm: () => applyClassificationToGroup(group, classification),
      // Per spec §7: saving a rule is a separate, explicit choice — never
      // the default action — so future transactions from this merchant are
      // suggested (not auto-classified) until Auto-Approve is turned on.
      extraLabel: `Apply + Suggest Rule for "${group.merchant}"`,
      extraClassName: 'btn-ghost',
      onExtra: () => applyClassificationToGroup(group, classification, { saveRule: true }),
    })
  }

  async function sendGroupToAccountant(group) {
    const candidates = group.txns.filter(t => t.classification === 'company_candidate' || t.classification === 'shared')
    if (candidates.length === 0) return
    const total = candidates.reduce((s, t) => s + (t.settlementAmount || 0), 0)
    setConfirmDialog({
      message: (
        <>
          Send {candidates.length} transaction{candidates.length === 1 ? '' : 's'} for Merchant: {group.merchant} to Accountant Review?<br />
          Estimated total: {candidates[0]?.settlementCurrency || ''} {total.toFixed(2)}
        </>
      ),
      confirmLabel: `Send ${candidates.length} to Accountant Review`,
      confirmClassName: 'btn-primary',
      onConfirm: async () => {
        for (let i = 0; i < candidates.length; i += 400) {
          const batch = writeBatch(db)
          candidates.slice(i, i + 400).forEach(t => batch.update(doc(db, 'paymentTransactions', t.id), {
            accountantStatus: 'pending',
            updatedAt: serverTimestamp(),
          }))
          await batch.commit()
        }
        setConfirmDialog(null)
      },
    })
  }

  async function setTxnClassification(txn, classification) {
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      classification,
      classificationSource: 'user',
      visibleToMembers: computeVisibleToMembers(classification),
      updatedAt: serverTimestamp(),
    })
    setBusyId(null)
  }

  async function saveBusinessPurpose(txn) {
    const draft = purposeDraft[txn.id] || {}
    const value = [draft.option, draft.note].filter(Boolean).join(' — ') || null
    setBusyId(txn.id)
    await updateDoc(doc(db, 'paymentTransactions', txn.id), { businessPurpose: value, updatedAt: serverTimestamp() })
    setBusyId(null)
  }

  // Mirrors Reconciliation.jsx's createExpenseFromTxn — same shape, plus
  // this workflow's classification/business-purpose fields so the new
  // Expense carries the evidence already gathered here.
  async function createExpenseFromTxn(txn) {
    if (CREATE_EXPENSE_BLOCKED_TYPES.includes(txn.transactionType)) return
    setBusyId(txn.id)
    const account = accountOf(txn.paymentAccountId)
    const source = account?.sourceType === 'credit_card' ? 'credit_card_statement' : 'bank_statement'
    const expenseRef = await addDoc(collection(db, 'expenses'), {
      userId: auth.currentUser.uid,
      userEmail: auth.currentUser.email,
      projectId: activeProject.id,
      date: txn.transactionDate || txn.postDate || '',
      vendor: txn.merchantNormalized ? txn.merchantNormalized.replace(/\b\w/g, c => c.toUpperCase()) : txn.merchantRaw,
      amount: txn.settlementAmount,
      currency: txn.settlementCurrency,
      category: 'Other',
      notes: `Statement description: "${txn.merchantRaw}". Created from personal statement — receipt missing.${txn.businessPurpose ? ` Business purpose: ${txn.businessPurpose}.` : ''}`,
      paymentMethod: '',
      images: [],
      receiptStatus: 'missing',
      reconciliationStatus: 'created_from_statement',
      source: 'personal_statement',
      sourceTransactionId: txn.id,
      sourceStatementImportId: txn.importId || null,
      sourceStatementRowText: txn.rawRowText || null,
      settlementAmount: txn.settlementAmount,
      settlementCurrency: txn.settlementCurrency,
      settlementStatus: 'confirmed',
      matchedPaymentTransactionId: txn.id,
      matchedPaymentAccountId: txn.paymentAccountId,
      createdAt: serverTimestamp(),
    })
    await updateDoc(doc(db, 'paymentTransactions', txn.id), {
      status: 'matched',
      matchedExpenseIds: [expenseRef.id],
      accountantStatus: 'pending',
      updatedAt: serverTimestamp(),
    })
    setBusyId(null)
  }

  function openExportModal() {
    setExportModal({
      period: new Date().toISOString().slice(0, 7),
      include: {
        company_candidate: true,
        company_confirmed: true,
        shared: true,
        needs_accountant_review: true,
        personal: false,
        rejected_company_claim: false,
      },
    })
  }

  function expenseFor(txn) { return expenses.find(e => e.id === txn.matchedExpenseIds?.[0]) }
  function importFor(txn) { return imports.find(i => i.id === txn.importId) }

  // Company Package Export (spec §10) — a ZIP of everything an accountant
  // needs to review and file a period's company-candidate transactions.
  // Only ever includes what the export modal's checkboxes select; Personal
  // and Rejected stay excluded unless the user explicitly opts in (spec
  // acceptance criterion 11).
  async function generateCompanyPackage() {
    const period = exportModal.period
    const included = classified.filter(t =>
      (t.transactionDate || '').startsWith(period) && exportModal.include[t.classification]
    )
    if (included.length === 0) { alert('No transactions match this period and selection.'); return }

    setExporting(true)
    setExportProgress('Building spreadsheet…')
    try {
      const zip = new JSZip()

      // expense-register.xlsx
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('Expense Register')
      ws.columns = [
        { header: 'Transaction Date', key: 'transactionDate', width: 14 },
        { header: 'Posting Date', key: 'postingDate', width: 14 },
        { header: 'Merchant', key: 'merchant', width: 26 },
        { header: 'Amount', key: 'amount', width: 12 },
        { header: 'Currency', key: 'currency', width: 10 },
        { header: 'Source Account', key: 'sourceAccount', width: 20 },
        { header: 'Source Type', key: 'sourceType', width: 14 },
        { header: 'Company', key: 'company', width: 18 },
        { header: 'Classification', key: 'classification', width: 22 },
        { header: 'Category Suggestion', key: 'categorySuggestion', width: 18 },
        { header: 'Business Purpose', key: 'businessPurpose', width: 24 },
        { header: 'Receipt Status', key: 'receiptStatus', width: 16 },
        { header: 'Linked Expense ID', key: 'linkedExpenseId', width: 22 },
        { header: 'Linked Statement Transaction ID', key: 'linkedStatementTransactionId', width: 28 },
        { header: 'Accountant Status', key: 'accountantStatus', width: 16 },
        { header: 'Review Note', key: 'reviewNote', width: 24 },
      ]
      const hdr = ws.getRow(1)
      hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A5C38' } }

      const registerRows = []
      for (const t of included) {
        const account = accountOf(t.paymentAccountId)
        const expense = expenseFor(t)
        registerRows.push({
          transactionDate: t.transactionDate || '',
          postingDate: t.postDate || '',
          merchant: t.merchantRaw || '',
          amount: t.settlementAmount,
          currency: t.settlementCurrency,
          sourceAccount: account?.label || '',
          sourceType: account?.sourceType || '',
          company: activeProject.name,
          classification: CLASSIFICATION_LABELS[t.classification] || t.classification,
          categorySuggestion: t.transactionType || '',
          businessPurpose: t.businessPurpose || '',
          receiptStatus: expense ? (expense.receiptStatus || 'receipt_attached') : 'missing',
          linkedExpenseId: expense?.id || '',
          linkedStatementTransactionId: t.id,
          accountantStatus: t.accountantStatus || 'not_required',
          reviewNote: t.reviewNote || '',
        })
      }
      registerRows.forEach(r => ws.addRow(r))
      const buf = await wb.xlsx.writeBuffer()
      zip.file('expense-register.xlsx', buf)

      // company-expense-summary.csv — totals by classification and currency
      const summaryRows = []
      const byClassCurrency = new Map()
      for (const t of included) {
        const key = `${t.classification}|${t.settlementCurrency}`
        const e = byClassCurrency.get(key) || { classification: t.classification, currency: t.settlementCurrency, count: 0, total: 0 }
        e.count++; e.total += t.settlementAmount || 0
        byClassCurrency.set(key, e)
      }
      for (const e of byClassCurrency.values()) {
        summaryRows.push({ Classification: CLASSIFICATION_LABELS[e.classification] || e.classification, Currency: e.currency, Count: e.count, Total: e.total.toFixed(2) })
      }
      zip.file('company-expense-summary.csv', toCsv(['Classification', 'Currency', 'Count', 'Total'], summaryRows))

      // accountant-review-list.csv — anything not yet a settled company_confirmed
      const reviewRows = included
        .filter(t => t.accountantStatus === 'pending' || t.classification === 'needs_accountant_review' || t.classification === 'shared')
        .map(t => ({
          TransactionDate: t.transactionDate || '',
          Merchant: t.merchantRaw || '',
          Amount: t.settlementAmount,
          Currency: t.settlementCurrency,
          Classification: CLASSIFICATION_LABELS[t.classification] || t.classification,
          AccountantStatus: t.accountantStatus || 'not_required',
          BusinessPurpose: t.businessPurpose || '',
          ReviewNote: t.reviewNote || '',
        }))
      zip.file('accountant-review-list.csv', toCsv(
        ['TransactionDate', 'Merchant', 'Amount', 'Currency', 'Classification', 'AccountantStatus', 'BusinessPurpose', 'ReviewNote'],
        reviewRows
      ))

      // missing-receipts.csv
      const missingRows = included
        .filter(t => { const e = expenseFor(t); return !e || e.receiptStatus === 'missing' })
        .map(t => ({ TransactionDate: t.transactionDate || '', Merchant: t.merchantRaw || '', Amount: t.settlementAmount, Currency: t.settlementCurrency, LinkedExpenseId: expenseFor(t)?.id || '' }))
      zip.file('missing-receipts.csv', toCsv(['TransactionDate', 'Merchant', 'Amount', 'Currency', 'LinkedExpenseId'], missingRows))

      // reimbursement-or-director-current-account.csv — Shared transactions
      // are flagged as CANDIDATES only; per spec §12 the app never decides
      // reimbursement vs. director current account itself.
      const sharedRows = included
        .filter(t => t.classification === 'shared')
        .map(t => ({ TransactionDate: t.transactionDate || '', Merchant: t.merchantRaw || '', Amount: t.settlementAmount, Currency: t.settlementCurrency, Note: 'Requires accountant decision: reimbursement vs. director current account' }))
      zip.file('reimbursement-or-director-current-account.csv', toCsv(['TransactionDate', 'Merchant', 'Amount', 'Currency', 'Note'], sharedRows))

      // source-statements/ — for company accounts, the original file in
      // full (never mixes personal data, always safe). For personal
      // accounts, the original statement mixes personal and company charges
      // in one file, so it's never bundled as-is. Instead:
      //  - PDF statements get a visually redacted copy (black boxes over
      //    every non-included row, via pdfRedaction.js) — real document,
      //    personal lines painted out, not a reformatted table.
      //  - A "-company-transactions-only.csv" excerpt is ALWAYS also
      //    included alongside it (belt-and-suspenders) — statement PDF
      //    parsing is documented elsewhere in this codebase as inherently
      //    heuristic, so an independently-computed CSV of exactly what's
      //    included stays available even if a row's geometry were ever
      //    slightly off.
      //  - If redaction can't be attempted safely (CSV-sourced import, or a
      //    layout the parser can't confidently box every row on), only the
      //    CSV excerpt is produced — never a PDF with a silent gap.
      setExportProgress('Downloading source statements…')
      const importIds = [...new Set(included.map(t => t.importId).filter(Boolean))]
      const redactedPdfNames = []
      const csvOnlyNames = []
      for (const importId of importIds) {
        const imp = imports.find(i => i.id === importId)
        if (!imp) continue

        if (accountOf(imp.paymentAccountId)?.ownershipType === 'personal') {
          const includedForImport = included.filter(t => t.importId === importId)
          if (includedForImport.length === 0) continue
          const safeName = (imp.sourceFileName || importId).replace(/\.[a-zA-Z0-9]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')

          zip.file(`source-statements/${safeName}-company-transactions-only.csv`, toCsv(
            ['TransactionDate', 'PostingDate', 'Merchant', 'Amount', 'Currency', 'Direction', 'Classification'],
            [...includedForImport].sort((a, b) => (a.transactionDate || '').localeCompare(b.transactionDate || '')).map(t => ({
              TransactionDate: t.transactionDate || '',
              PostingDate: t.postDate || '',
              Merchant: t.merchantRaw || '',
              Amount: t.settlementAmount,
              Currency: t.settlementCurrency,
              Direction: t.direction || '',
              Classification: CLASSIFICATION_LABELS[t.classification] || t.classification,
            }))
          ))

          let redacted = false
          if (imp.sourceType === 'pdf' && imp.sourceFileUrl) {
            try {
              const res = await fetch('/api/download-receipt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: imp.sourceFileUrl }) })
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              const blob = await res.blob()
              const file = new File([blob], imp.sourceFileName || 'statement.pdf', { type: 'application/pdf' })
              const reparsed = await parsePdfStatement(file)
              // Every re-parsed row must carry mask geometry, or this
              // statement's layout fell through to the coordinate-free
              // fallback parser — never attempt a partial redaction where
              // some rows have no bounding box to mask with.
              if (reparsed.rows.length > 0 && reparsed.rows.every(r => r.maskRect)) {
                const includedRowIndexes = new Set(includedForImport.map(t => t.sourceRowIndex))
                const maskRects = reparsed.rows
                  .filter(r => !includedRowIndexes.has(r.sourceRowIndex))
                  .map(r => r.maskRect)
                const redactedBlob = await maskPdfPages(blob, maskRects)
                zip.file(`source-statements/${safeName}-redacted.pdf`, await redactedBlob.arrayBuffer())
                redactedPdfNames.push(imp.sourceFileName || importId)
                redacted = true
              }
            } catch (err) {
              console.warn('Could not produce a redacted statement PDF, CSV excerpt only:', imp.sourceFileName, err.message)
            }
          }
          if (!redacted) csvOnlyNames.push(imp.sourceFileName || importId)
          continue
        }

        if (!imp.sourceFileUrl) continue
        try {
          const res = await fetch('/api/download-receipt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: imp.sourceFileUrl }) })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          zip.file(`source-statements/${imp.sourceFileName || importId}`, await res.arrayBuffer())
        } catch (err) {
          console.warn('Could not download source statement:', imp.sourceFileName, err.message)
        }
      }
      if (redactedPdfNames.length > 0 || csvOnlyNames.length > 0) {
        zip.file(
          'source-statements/PERSONAL_ACCOUNT_STATEMENTS_REDACTED.txt',
          `Statements below come from a personal account and were NOT included as-is — they mix personal and company charges together, and including the original would expose personal transactions regardless of classification filtering.\n\n` +
          (redactedPdfNames.length > 0
            ? `The following have a "-redacted.pdf" copy: every non-included transaction row is painted over with a solid black box on the real statement page (a "-company-transactions-only.csv" excerpt is also included for each, as an independent backup record of exactly what's included):\n${redactedPdfNames.join('\n')}\n\n`
            : '') +
          (csvOnlyNames.length > 0
            ? `The following could not be safely visually redacted (e.g. a CSV-sourced import, or a statement layout the parser couldn't confidently box every row on) — only a "-company-transactions-only.csv" excerpt is provided, listing exactly the company-classified transactions included in this export:\n${csvOnlyNames.join('\n')}\n\n`
            : '') +
          `This is an automated best-effort redaction — please do a quick visual spot-check of any "-redacted.pdf" file before sending it on, the same way you would review any auto-generated document.`
        )
      }

      // receipts/ — images from any linked Expense
      setExportProgress('Downloading receipts…')
      let receiptCount = 0
      for (const t of included) {
        const expense = expenseFor(t)
        if (!expense?.images?.length) continue
        for (let i = 0; i < expense.images.length; i++) {
          const img = expense.images[i]
          if (!img.path) continue
          try {
            const res = await fetch('/api/download-receipt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: img.url }) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const ext = img.path.split('.').pop() || 'jpg'
            zip.file(`receipts/${t.transactionDate}_${expense.vendor || 'receipt'}${expense.images.length > 1 ? `_${i + 1}` : ''}.${ext}`, await res.arrayBuffer())
            receiptCount++
          } catch (err) {
            console.warn('Could not download receipt:', img.name, err.message)
          }
        }
      }

      // manifest.json
      const manifest = {
        companyId: activeProject.id,
        company: activeProject.name,
        period,
        generatedAt: new Date().toISOString(),
        generatedBy: auth.currentUser.email,
        transactionCount: included.length,
        receiptCount,
        missingReceiptCount: missingRows.length,
        includedStatuses: Object.entries(exportModal.include).filter(([, v]) => v).map(([k]) => k),
        sourceStatementIds: importIds,
        personalAccountStatementsRedactedPdf: redactedPdfNames.length,
        personalAccountStatementsCsvOnly: csvOnlyNames.length,
      }
      zip.file('manifest.json', JSON.stringify(manifest, null, 2))

      setExportProgress('Compressing…')
      const blob = await zip.generateAsync({ type: 'blob' })
      const safeCompany = (activeProject.name || 'Company').replace(/[^a-zA-Z0-9-]/g, '-')
      triggerDownload(blob, `${safeCompany}-Company-Expenses-${period}.zip`)
      setExportModal(null)
    } catch (err) {
      alert('Export failed: ' + err.message)
    }
    setExporting(false)
    setExportProgress('')
  }

  async function toggleRuleAutoApprove(rule) {
    await updateDoc(doc(db, 'merchantRules', rule.id), { autoApprove: !rule.autoApprove, updatedAt: serverTimestamp() })
  }

  async function deleteRule(rule) {
    setConfirmDialog({
      message: <>Delete the rule for <strong>{rule.merchantLabel || rule.merchantKey}</strong>? Its transactions keep their current classification — only future imports stop using this rule.</>,
      confirmLabel: 'Delete Rule',
      confirmClassName: 'btn-danger',
      onConfirm: async () => { await deleteDoc(doc(db, 'merchantRules', rule.id)); setConfirmDialog(null) },
    })
  }

  if (!activeProject) return <div className="page page-standard"><p className="loading">Loading…</p></div>

  return (
    <div className="page page-standard">
      <ProjectBanner />
      <h2>Company Review</h2>
      <p className="hint">
        Transactions on personal accounts marked as mixing personal and company spending. The app only suggests
        classification and gathers evidence — the accountant/bookkeeper makes the final claim decision.
      </p>

      {personalAccountIds.length === 0 ? (
        <p className="empty">No personal accounts yet. Mark an account as personal in Payment Sources to start reviewing its transactions here.</p>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat-card"><div className="stat-label">Company Candidates</div><div className="stat-value">{summary.company_candidate}</div></div>
            <div className="stat-card"><div className="stat-label">Personal</div><div className="stat-value">{summary.personal}</div></div>
            <div className="stat-card"><div className="stat-label">Needs Review</div><div className="stat-value">{summary.needs_accountant_review}</div></div>
            <div className="stat-card"><div className="stat-label">Missing Receipt</div><div className="stat-value">{summary.missing_receipt}</div></div>
          </div>

          <div className="action-row">
            <button className="btn-primary" onClick={openExportModal}>Export Company Package</button>
          </div>

          {rules.length > 0 && (
            <div className="card">
              <h3>Merchant Rules</h3>
              <p className="hint">
                Built from "Apply + Suggest Rule" below. A rule only suggests a classification unless
                Auto-Approve is turned on for that merchant — turning it on means future imports from
                this merchant classify automatically.
              </p>
              {rules.map(rule => (
                <div key={rule.id} className="category-row">
                  <span>
                    <strong>{rule.merchantLabel || rule.merchantKey}</strong>
                    <span className="hint"> → {CLASSIFICATION_LABELS[rule.classification] || rule.classification}</span>
                  </span>
                  <span className="action-row" style={{ margin: 0 }}>
                    <button className={`btn-small${rule.autoApprove ? ' btn-primary' : ' btn-ghost'}`} onClick={() => toggleRuleAutoApprove(rule)}>
                      {rule.autoApprove ? 'Auto-Approve: On' : 'Auto-Approve: Off'}
                    </button>
                    <button className="btn-small btn-danger" onClick={() => deleteRule(rule)}>Delete</button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <h3>Grouped by Merchant</h3>
            {groups.length === 0 && <p className="empty">No transactions yet — import a statement for a personal account in Payment Sources.</p>}

            {groups.map(group => {
              const total = group.txns.reduce((s, t) => s + (t.settlementAmount || 0), 0)
              const suggested = group.txns[0]?.classification
              const currency = group.txns[0]?.settlementCurrency || ''
              const expanded = expandedMerchant === group.key
              // A rule suggestion only ever shows up as metadata alongside
              // the existing classification — applying it still goes
              // through the same count+total confirm flow as any other
              // bulk action, never a silent auto-apply.
              const ruleSuggestion = group.txns.find(t => t.suggestedClassification)?.suggestedClassification

              return (
                <div key={group.key} className="company-review-group">
                  <div className="company-review-group-header">
                    <div>
                      <span className="mob-card-vendor">{group.merchant}</span>
                      <span className="hint"> · {group.txns.length} transaction{group.txns.length === 1 ? '' : 's'} · {currency} {total.toFixed(2)}</span>
                    </div>
                    <span className={`badge ${CLASSIFICATION_BADGE_CLASS[suggested] || 'badge-other'}`}>{CLASSIFICATION_LABELS[suggested] || suggested}</span>
                  </div>
                  {ruleSuggestion && (
                    <p className="hint">
                      Rule suggests <strong>{CLASSIFICATION_LABELS[ruleSuggestion]}</strong> for this merchant.{' '}
                      <button className="btn-small btn-ghost" style={{ display: 'inline-block' }} onClick={() => confirmGroupAction(group, ruleSuggestion, CLASSIFICATION_LABELS[ruleSuggestion])}>Apply Rule</button>
                    </p>
                  )}
                  <div className="action-row">
                    <button className="btn-small" onClick={() => confirmGroupAction(group, 'company_candidate', CLASSIFICATION_LABELS.company_candidate)}>Confirm All as Company</button>
                    <button className="btn-small btn-ghost" onClick={() => confirmGroupAction(group, 'personal', CLASSIFICATION_LABELS.personal)}>Mark All Personal</button>
                    <button className="btn-small btn-ghost" onClick={() => sendGroupToAccountant(group)}>Send to Accountant Review</button>
                    <button className="btn-small btn-ghost" onClick={() => setExpandedMerchant(expanded ? null : group.key)}>
                      {expanded ? 'Hide' : 'Open Exceptions'}
                    </button>
                  </div>

                  {expanded && (
                    <div className="txn-detail-box">
                      <div className="txn-detail-scroll">
                        <div className="mobile-only">
                          {group.txns.map(txn => {
                            const draft = purposeDraft[txn.id] || {}
                            return (
                              <div key={txn.id} className="expense-mob-card">
                                <div className="mob-card-header">
                                  <span className="mob-card-vendor">{txn.merchantRaw}</span>
                                  <span className="mob-card-amount" data-amount="true">{txn.direction === 'debit' ? '-' : '+'}{txn.settlementAmount?.toFixed(2)}</span>
                                </div>
                                <div className="mob-card-sub">
                                  <span className="mob-card-date">{txn.transactionDate}</span>
                                  <span className={`badge ${CLASSIFICATION_BADGE_CLASS[txn.classification] || 'badge-other'}`}>{CLASSIFICATION_LABELS[txn.classification]}</span>
                                </div>
                                <div className="action-row" style={{ marginTop: 6 }}>
                                  <select value={txn.classification} disabled={busyId === txn.id} onChange={e => setTxnClassification(txn, e.target.value)}>
                                    {Object.entries(CLASSIFICATION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                  </select>
                                </div>
                                <div className="action-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                                  {BUSINESS_PURPOSE_OPTIONS.map(opt => (
                                    <button
                                      key={opt}
                                      className={`btn-small${draft.option === opt ? ' btn-primary' : ' btn-ghost'}`}
                                      onClick={() => setPurposeDraft(p => ({ ...p, [txn.id]: { ...p[txn.id], option: opt } }))}
                                    >{opt}</button>
                                  ))}
                                </div>
                                <input
                                  placeholder="Optional note"
                                  value={draft.note || ''}
                                  onChange={e => setPurposeDraft(p => ({ ...p, [txn.id]: { ...p[txn.id], note: e.target.value } }))}
                                  onBlur={() => saveBusinessPurpose(txn)}
                                  style={{ marginTop: 6 }}
                                />
                                {txn.businessPurpose && <div className="hint">Saved: {txn.businessPurpose}</div>}
                                <div className="mob-card-actions">
                                  {txn.status !== 'matched' && (
                                    <button className="btn-small" disabled={busyId === txn.id} onClick={() => createExpenseFromTxn(txn)}>
                                      {busyId === txn.id ? 'Creating…' : 'Create Expense'}
                                    </button>
                                  )}
                                  {txn.status === 'matched' && <span className="hint">Linked to Expense</span>}
                                </div>
                              </div>
                            )
                          })}
                        </div>

                        <table className="txn-table-compact desktop-only">
                          <thead>
                            <tr><th>Date</th><th>Merchant</th><th>Amount</th><th>Classification</th><th>Business Purpose</th><th>Actions</th></tr>
                          </thead>
                          <tbody>
                            {group.txns.map(txn => {
                              const draft = purposeDraft[txn.id] || {}
                              return (
                                <tr key={txn.id}>
                                  <td>{txn.transactionDate}</td>
                                  <td>{txn.merchantRaw}</td>
                                  <td data-amount="true">{txn.direction === 'debit' ? '-' : '+'}{txn.settlementAmount?.toFixed(2)}</td>
                                  <td>
                                    <select value={txn.classification} disabled={busyId === txn.id} onChange={e => setTxnClassification(txn, e.target.value)}>
                                      {Object.entries(CLASSIFICATION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                    </select>
                                  </td>
                                  <td>
                                    <div className="action-row" style={{ flexWrap: 'wrap', marginBottom: 4 }}>
                                      {BUSINESS_PURPOSE_OPTIONS.map(opt => (
                                        <button
                                          key={opt}
                                          className={`btn-small${draft.option === opt ? ' btn-primary' : ' btn-ghost'}`}
                                          onClick={() => setPurposeDraft(p => ({ ...p, [txn.id]: { ...p[txn.id], option: opt } }))}
                                        >{opt}</button>
                                      ))}
                                    </div>
                                    <input
                                      placeholder="Optional note"
                                      value={draft.note || ''}
                                      onChange={e => setPurposeDraft(p => ({ ...p, [txn.id]: { ...p[txn.id], note: e.target.value } }))}
                                      onBlur={() => saveBusinessPurpose(txn)}
                                    />
                                    {txn.businessPurpose && <div className="hint">Saved: {txn.businessPurpose}</div>}
                                  </td>
                                  <td>
                                    {txn.status !== 'matched'
                                      ? <button className="btn-small" disabled={busyId === txn.id} onClick={() => createExpenseFromTxn(txn)}>
                                          {busyId === txn.id ? 'Creating…' : 'Create Expense'}
                                        </button>
                                      : <span className="hint">Linked to Expense</span>}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          confirmClassName={confirmDialog.confirmClassName}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
          extraLabel={confirmDialog.extraLabel}
          extraClassName={confirmDialog.extraClassName}
          onExtra={confirmDialog.onExtra}
        />
      )}

      {exportModal && (
        <div className="confirm-overlay" onClick={() => !exporting && setExportModal(null)}>
          <div className="confirm-box confirm-box-wide" onClick={e => e.stopPropagation()}>
            <h3>Export Company Package</h3>
            <p className="hint">Company: {activeProject.name}</p>
            <label className="checkbox-row" style={{ display: 'block', marginBottom: 12 }}>
              Period
              <input
                type="month"
                value={exportModal.period}
                onChange={e => setExportModal({ ...exportModal, period: e.target.value })}
                style={{ marginTop: 4, width: '100%' }}
              />
            </label>
            <div className="export-include-grid">
              <span className="stat-label">Include</span>
              {Object.keys(CLASSIFICATION_LABELS).map(c => (
                <label key={c} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={!!exportModal.include[c]}
                    onChange={e => setExportModal({ ...exportModal, include: { ...exportModal.include, [c]: e.target.checked } })}
                  />
                  {CLASSIFICATION_LABELS[c]}
                </label>
              ))}
            </div>
            {exporting && (
              <>
                <p className="hint">{exportProgress}</p>
                <div className="scan-progress-bar"><div className="scan-progress-fill" /></div>
              </>
            )}
            <div className="confirm-actions">
              <button className="btn-ghost" disabled={exporting} onClick={() => setExportModal(null)}>Cancel</button>
              <button className="btn-primary" disabled={exporting} onClick={generateCompanyPackage}>
                {exporting ? 'Generating…' : 'Generate Package'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
