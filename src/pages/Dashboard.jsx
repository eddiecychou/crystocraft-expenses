import { useState, useEffect } from 'react'
import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore'
import { db, auth } from '../firebase'
import { Link } from 'react-router-dom'

const CATEGORIES = ['Travel', 'Meals', 'Office', 'Software', 'Utilities', 'Other']

export default function Dashboard() {
  const [expenses, setExpenses] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const q = query(
        collection(db, 'expenses'),
        where('userId', '==', auth.currentUser.uid),
        orderBy('createdAt', 'desc'),
        limit(10)
      )
      const snap = await getDocs(q)
      setExpenses(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoading(false)
    }
    load()
  }, [])

  const total = expenses.reduce((sum, e) => sum + (e.amount || 0), 0)
  const defaultCurrency = expenses[0]?.currency || 'HKD'
  const byCategory = CATEGORIES
    .map(cat => ({ cat, total: expenses.filter(e => e.category === cat).reduce((s, e) => s + (e.amount || 0), 0) }))
    .filter(c => c.total > 0)

  if (loading) return <div className="loading">Loading…</div>

  return (
    <div className="page">
      <h2>Dashboard</h2>

      <div className="stat-row">
        <div className="stat-card">
          <div className="stat-label">Recent entries</div>
          <div className="stat-value">{expenses.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total (last 10)</div>
          <div className="stat-value">{defaultCurrency} {total.toFixed(2)}</div>
        </div>
      </div>

      {byCategory.length > 0 && (
        <div className="card">
          <h3>By Category</h3>
          {byCategory.map(c => (
            <div key={c.cat} className="category-row">
              <span>{c.cat}</span>
              <span>{c.total.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h3>Recent Expenses</h3>
          <Link to="/upload" className="btn-primary">+ Upload Receipt</Link>
        </div>
        {expenses.length === 0
          ? <p className="empty">No expenses yet. <Link to="/upload">Upload your first receipt.</Link></p>
          : expenses.map(e => (
            <div key={e.id} className="expense-row">
              <span className="date">{e.date}</span>
              <span className="vendor">{e.vendor}</span>
              <span className="amount">{e.currency} {e.amount?.toFixed(2)}</span>
              <span className="badge">{e.category}</span>
            </div>
          ))
        }
      </div>
    </div>
  )
}
