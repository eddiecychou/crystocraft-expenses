import { useState, useEffect } from 'react'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { Link } from 'react-router-dom'
import { CATEGORIES } from '../constants'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'

function isoDate(d) { return d.toISOString().slice(0, 10) }

function firstOfMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export default function Dashboard() {
  const { activeProject, projects, loading: projectLoading } = useProject()
  const [allExpenses, setAllExpenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(() => isoDate(new Date()))

  // Fetch once per project — date filters are applied in memory below
  useEffect(() => {
    if (projectLoading || !activeProject) return
    async function load() {
      setLoading(true)
      try {
        const snap = await getDocs(
          query(collection(db, 'expenses'), where('userId', '==', auth.currentUser.uid))
        )
        let list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        const defaultProjectId = (projects.find(p => p.name === 'Default') || projects[0])?.id
        list = list.filter(e =>
          e.projectId === activeProject.id ||
          (!e.projectId && activeProject.id === defaultProjectId)
        )
        list.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        setAllExpenses(list)
      } catch (err) {
        console.error('Dashboard load error:', err)
      }
      setLoading(false)
    }
    load()
  }, [activeProject?.id, projectLoading])

  // Apply date filters in memory — no network round-trip
  const expenses = allExpenses.filter(e => {
    if (from && e.date < from) return false
    if (to   && e.date > to)   return false
    return true
  })

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

  const byCategory = CATEGORIES
    .map(cat => {
      const totals = {}
      expenses.filter(e => e.category === cat).forEach(e => {
        const c = e.currency || 'HKD'
        totals[c] = (totals[c] || 0) + (e.amount || 0)
      })
      return { cat, totals }
    })
    .filter(c => Object.keys(c.totals).length > 0)

  if (projectLoading) return <div className="loading">Loading…</div>

  return (
    <div className="page">
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

      {loading ? <div className="loading">Loading…</div> : (
        <>
          <div className="stat-row">
            <div className="stat-card">
              <div className="stat-label">Entries</div>
              <div className="stat-value">{expenses.length}</div>
            </div>
          </div>

          {byCategory.length > 0 && (
            <div className="card">
              <h3>By Category</h3>
              {byCategory.map(c => (
                <div key={c.cat} className="category-row">
                  <span className={`badge badge-${c.cat.toLowerCase().replace(/\s+/g, '-')}`}>{c.cat}</span>
                  <span>{Object.entries(c.totals).map(([cur, amt]) => `${cur} ${amt.toFixed(2)}`).join('  |  ')}</span>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <h3>Expenses</h3>
              <Link to="/upload" className="btn-primary">+ Upload Receipt</Link>
            </div>
            {expenses.length === 0
              ? <p className="empty">No expenses for this period. <Link to="/upload">Upload a receipt.</Link></p>
              : (
                <>
                  {expenses.map(e => (
                    <div key={e.id} className="expense-row">
                      <span className="date">{e.date}</span>
                      <span className="vendor">{e.vendor}</span>
                      <span className="amount">{e.currency} {e.amount?.toFixed(2)}</span>
                      <span className={`badge badge-${e.category.toLowerCase().replace(/\s+/g, '-')}`}>{e.category}</span>
                    </div>
                  ))}
                  <div className="expense-total-row">
                    {Object.entries(totals).map(([currency, amount]) => (
                      <span key={currency}>{currency} {amount.toFixed(2)}</span>
                    ))}
                  </div>
                </>
              )
            }
          </div>
        </>
      )}
    </div>
  )
}
