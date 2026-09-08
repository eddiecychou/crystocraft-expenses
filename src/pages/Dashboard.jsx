import { useState, useEffect } from 'react'
import { collection, query, where, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { Link } from 'react-router-dom'
import { projectCategories, projectIncomeCategories } from '../constants'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import LoadingBar from '../components/LoadingBar'

// Sums a list of records (each with amount/currency) into { currency: total }.
function totalsByCurrency(records) {
  const totals = {}
  records.forEach(r => {
    const c = r.currency || 'HKD'
    totals[c] = (totals[c] || 0) + (r.amount || 0)
  })
  return totals
}

function isoDate(d) { return d.toISOString().slice(0, 10) }

function firstOfMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export default function Dashboard() {
  const { activeProject, loading: projectLoading } = useProject()
  const [allExpenses, setAllExpenses] = useState([])
  // Income/Sales Invoices/Purchase Orders — added so Overview reflects the
  // full picture, not Expenses only (they were entirely invisible here
  // before). Kept as their own state/sections rather than merged into the
  // Expense totals above: expenses/income/salesInvoices/purchaseOrders
  // never share a line item (a bank match sets a foreign key on exactly
  // one of them), so summing all four is safe, but blending an
  // OC-covered figure into a Finance-only one under one label would be
  // confusing — each stays its own clearly-labeled total.
  const [allIncome, setAllIncome] = useState([])
  const [allInvoices, setAllInvoices] = useState([])
  const [allPurchaseOrders, setAllPurchaseOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(() => isoDate(new Date()))

  // Subscribe once per project — onSnapshot caches in IndexedDB for instant repeat loads.
  // Scoped by projectId (not userId) so a shared project's expenses show up
  // for every collaborator, not just whoever created each record. Legacy
  // expenses with no projectId are backfilled by ProjectContext's
  // migrateExpenses before this ever runs, so no client-side fallback filter
  // is needed here.
  useEffect(() => {
    if (projectLoading || !activeProject) return
    setLoading(true)
    const unsubscribe = onSnapshot(
      query(collection(db, 'expenses'), where('projectId', '==', activeProject.id)),
      snap => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        list.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        setAllExpenses(list)
        setLoading(false)
      },
      err => {
        console.error('Dashboard load error:', err)
        setLoading(false)
      }
    )
    const unsubIncome = onSnapshot(
      query(collection(db, 'income'), where('projectId', '==', activeProject.id)),
      snap => setAllIncome(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date || '').localeCompare(a.date || '')))
    )
    const unsubInvoices = onSnapshot(
      query(collection(db, 'salesInvoices'), where('projectId', '==', activeProject.id)),
      snap => setAllInvoices(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    const unsubPos = onSnapshot(
      query(collection(db, 'purchaseOrders'), where('projectId', '==', activeProject.id)),
      snap => setAllPurchaseOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    return () => { unsubscribe(); unsubIncome(); unsubInvoices(); unsubPos() }
  }, [activeProject?.id, projectLoading])

  // Apply date filters in memory — no network round-trip
  const expenses = allExpenses.filter(e => {
    if (from && e.date < from) return false
    if (to   && e.date > to)   return false
    return true
  })
  const inRange = r => (!from || r.date >= from) && (!to || r.date <= to)
  const income = allIncome.filter(inRange)
  const invoices = allInvoices.filter(inRange)
  const purchaseOrders = allPurchaseOrders.filter(inRange)

  function setPreset(preset) {
    const now = new Date()
    if (preset === 'this-month') {
      setFrom(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
      setTo(isoDate(now))
    } else if (preset === 'last-month') {
      const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
      const m = now.getMonth() === 0 ? 12 : now.getMonth()
      setFrom(`${y}-${String(m).padStart(2, '0')}-01`)
      setTo(isoDate(new Date(now.getFullYear(), now.getMonth(), 0)))
    } else if (preset === 'this-year') {
      setFrom(`${now.getFullYear()}-01-01`)
      setTo(isoDate(now))
    } else {
      setFrom('')
      setTo('')
    }
  }

  const totals = {}
  expenses.forEach(e => {
    const c = e.currency || 'HKD'
    totals[c] = (totals[c] || 0) + (e.amount || 0)
  })

  // Union with whatever categories actually appear in the data, not just
  // the project's currently-configured list — a category later removed
  // from Settings (or left over from before per-project Categories
  // existed) must still show its historical total here, never silently
  // vanish from the breakdown.
  const allCategoryNames = [...new Set([...projectCategories(activeProject), ...expenses.map(e => e.category).filter(Boolean)])]
  const byCategory = allCategoryNames
    .map(cat => {
      const totals = {}
      expenses.filter(e => e.category === cat).forEach(e => {
        const c = e.currency || 'HKD'
        totals[c] = (totals[c] || 0) + (e.amount || 0)
      })
      return { cat, totals }
    })
    .filter(c => Object.keys(c.totals).length > 0)

  // Income mirrors Expenses' own by-category breakdown exactly — same
  // "union with whatever's actually in the data" reasoning as above.
  const incomeTotals = totalsByCurrency(income)
  const allIncomeCategoryNames = [...new Set([...projectIncomeCategories(activeProject), ...income.map(i => i.category).filter(Boolean)])]
  const incomeByCategory = allIncomeCategoryNames
    .map(cat => ({ cat, totals: totalsByCurrency(income.filter(i => i.category === cat)) }))
    .filter(c => Object.keys(c.totals).length > 0)

  // Sales Invoices / Purchase Orders — compact totals only, not a full
  // row-list (they already have their own detail page, Invoices.jsx, and
  // Reconciliation). Overview just needs to surface that they exist and
  // their size for the period.
  const invoiceTotals = totalsByCurrency(invoices)
  const poTotals = totalsByCurrency(purchaseOrders)

  if (projectLoading) return (
    <div className="page page-standard">
      <ProjectBanner />
      <h2>Dashboard</h2>
      <LoadingBar label="Loading expenses…" />
    </div>
  )

  return (
    <div className="page page-standard">
      <ProjectBanner />
      <h2>Dashboard</h2>

      <div className="filter-row">
        <div className="date-range">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
          <span className="date-sep">–</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="preset-btns">
          <button onClick={() => setPreset('this-month')} className="btn-small btn-ghost">This Month</button>
          <button onClick={() => setPreset('last-month')} className="btn-small btn-ghost">Last Month</button>
          <button onClick={() => setPreset('this-year')} className="btn-small btn-ghost">This Year</button>
          <button onClick={() => setPreset('all')} className="btn-small btn-ghost">All</button>
        </div>
      </div>

      {loading ? <LoadingBar label="Loading expenses…" /> : (
        <>
          <div className="stat-row">
            <div className="stat-card">
              <div className="stat-label">Entries</div>
              <div className="stat-value">{expenses.length}</div>
            </div>
          </div>

          <div className="dashboard-grid">
          {byCategory.length > 0 && (
            <div className="card dashboard-span-4">
              <h3>By Category</h3>
              {byCategory.map(c => (
                <div key={c.cat} className="category-row">
                  <span className={`badge badge-${c.cat.toLowerCase().replace(/\s+/g, '-')}`}>{c.cat}</span>
                  <span>{Object.entries(c.totals).map(([cur, amt]) => `${cur} ${amt.toFixed(2)}`).join('  |  ')}</span>
                </div>
              ))}
            </div>
          )}

          <div className={`card ${byCategory.length > 0 ? 'dashboard-span-8' : 'dashboard-span-12'}`}>
            <div className="card-header">
              <h3>Expenses</h3>
              <Link to="/upload" className="btn-primary">+ Upload Receipt</Link>
            </div>
            {expenses.length === 0
              ? <p className="empty">No expenses for this period. <Link to="/upload">Upload a receipt.</Link></p>
              : (
                <>
                  <div className="dashboard-list-scroll">
                    {expenses.map(e => (
                      <div key={e.id} className="expense-row">
                        <span className="date">{e.date}</span>
                        <span className="vendor">{e.vendor}</span>
                        <span className="amount">{e.currency} {e.amount?.toFixed(2)}</span>
                        <span className={`badge badge-${e.category.toLowerCase().replace(/\s+/g, '-')}`}>{e.category}</span>
                      </div>
                    ))}
                  </div>
                  <div className="expense-total-row">
                    {Object.entries(totals).map(([currency, amount]) => (
                      <span key={currency}>{currency} {amount.toFixed(2)}</span>
                    ))}
                  </div>
                </>
              )
            }
          </div>

          {/* Income — full treatment mirroring Expenses above: a
              Finance-native record type at the same level, not a lesser
              citizen. Was entirely invisible on Overview before this. */}
          {incomeByCategory.length > 0 && (
            <div className="card dashboard-span-4">
              <h3>Income By Category</h3>
              {incomeByCategory.map(c => (
                <div key={c.cat} className="category-row">
                  <span className={`badge badge-${c.cat.toLowerCase().replace(/\s+/g, '-')}`}>{c.cat}</span>
                  <span>{Object.entries(c.totals).map(([cur, amt]) => `${cur} ${amt.toFixed(2)}`).join('  |  ')}</span>
                </div>
              ))}
            </div>
          )}

          <div className={`card ${incomeByCategory.length > 0 ? 'dashboard-span-8' : 'dashboard-span-12'}`}>
            <div className="card-header">
              <h3>Income</h3>
              <Link to="/income" className="btn-primary">+ Upload Income</Link>
            </div>
            {income.length === 0
              ? <p className="empty">No income for this period. <Link to="/income">Upload income.</Link></p>
              : (
                <>
                  <div className="dashboard-list-scroll">
                    {income.map(i => (
                      <div key={i.id} className="expense-row">
                        <span className="date">{i.date}</span>
                        <span className="vendor">{i.counterpartyName}</span>
                        <span className="amount">{i.currency} {Number(i.amount || 0).toFixed(2)}</span>
                        {i.category && <span className={`badge badge-${i.category.toLowerCase().replace(/\s+/g, '-')}`}>{i.category}</span>}
                      </div>
                    ))}
                  </div>
                  <div className="expense-total-row">
                    {Object.entries(incomeTotals).map(([currency, amount]) => (
                      <span key={currency}>{currency} {amount.toFixed(2)}</span>
                    ))}
                  </div>
                </>
              )
            }
          </div>

          {/* Business (Operation Center) — compact totals only, not a
              third full row-list; Sales Invoices/Purchase Orders already
              have their own detail page (Invoices.jsx) and Reconciliation.
              Kept as its own explicitly-labeled figure, never summed into
              Income/Expenses above — an OC-covered total and a
              Finance-only total answer different questions. */}
          <div className="card dashboard-span-6">
            <h3>Sales Invoices (Operation Center)</h3>
            {invoices.length === 0
              ? <p className="empty">No sales invoices for this period.</p>
              : (
                <div className="expense-total-row">
                  {Object.entries(invoiceTotals).map(([currency, amount]) => (
                    <span key={currency}>{currency} {amount.toFixed(2)}</span>
                  ))}
                  <span className="hint" style={{ marginLeft: 8 }}>({invoices.length})</span>
                </div>
              )
            }
            <Link to="/invoices" className="btn-ghost btn-small" style={{ marginTop: 8 }}>View Invoices & POs</Link>
          </div>

          <div className="card dashboard-span-6">
            <h3>Purchase Orders (Operation Center)</h3>
            {purchaseOrders.length === 0
              ? <p className="empty">No purchase orders for this period.</p>
              : (
                <div className="expense-total-row">
                  {Object.entries(poTotals).map(([currency, amount]) => (
                    <span key={currency}>{currency} {amount.toFixed(2)}</span>
                  ))}
                  <span className="hint" style={{ marginLeft: 8 }}>({purchaseOrders.length})</span>
                </div>
              )
            }
            <Link to="/invoices" className="btn-ghost btn-small" style={{ marginTop: 8 }}>View Invoices & POs</Link>
          </div>
          </div>
        </>
      )}
    </div>
  )
}
