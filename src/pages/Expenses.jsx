import { useState, useEffect } from 'react'
import { collection, query, where, orderBy, getDocs, doc, updateDoc, deleteDoc } from 'firebase/firestore'
import { db, auth } from '../firebase'

const CATEGORIES = ['Travel', 'Meals', 'Office', 'Software', 'Utilities', 'Other']
const CURRENCIES = ['HKD', 'RMB', 'USD', 'EUR', 'JPY', 'AUD', 'GBP', 'SGD', 'CAD', 'KRW', 'Other']

export default function Expenses() {
  const [expenses, setExpenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState(null)
  const [editData, setEditData] = useState({})

  async function load() {
    const q = query(
      collection(db, 'expenses'),
      where('userId', '==', auth.currentUser.uid),
      orderBy('date', 'desc')
    )
    const snap = await getDocs(q)
    setExpenses(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function saveEdit() {
    const { id, userId, userEmail, createdAt, ...fields } = editData
    await updateDoc(doc(db, 'expenses', editId), {
      ...fields,
      amount: parseFloat(fields.amount) || 0,
    })
    setEditId(null)
    load()
  }

  async function deleteExpense(id) {
    if (!confirm('Delete this expense?')) return
    await deleteDoc(doc(db, 'expenses', id))
    load()
  }

  if (loading) return <div className="loading">Loading…</div>

  return (
    <div className="page">
      <h2>All Expenses</h2>
      {expenses.length === 0
        ? <p className="empty">No expenses yet.</p>
        : (
          <div className="table-wrap">
            <table className="expense-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Vendor</th>
                  <th>Amount</th>
                  <th>Currency</th>
                  <th>Category</th>
                  <th>Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map(e => (
                  <tr key={e.id}>
                    {editId === e.id ? (
                      <>
                        <td><input type="date" value={editData.date || ''} onChange={ev => setEditData(p => ({ ...p, date: ev.target.value }))} /></td>
                        <td><input value={editData.vendor || ''} onChange={ev => setEditData(p => ({ ...p, vendor: ev.target.value }))} /></td>
                        <td><input type="number" min="0" step="0.01" value={editData.amount || ''} onChange={ev => setEditData(p => ({ ...p, amount: ev.target.value }))} /></td>
                        <td>
                          <select value={editData.currency} onChange={ev => setEditData(p => ({ ...p, currency: ev.target.value }))}>
                            {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                          </select>
                        </td>
                        <td>
                          <select value={editData.category} onChange={ev => setEditData(p => ({ ...p, category: ev.target.value }))}>
                            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                          </select>
                        </td>
                        <td><input value={editData.notes} onChange={ev => setEditData(p => ({ ...p, notes: ev.target.value }))} /></td>
                        <td>
                          <button onClick={saveEdit} className="btn-small">Save</button>
                          <button onClick={() => setEditId(null)} className="btn-small btn-ghost">Cancel</button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{e.date}</td>
                        <td>{e.vendor}</td>
                        <td>{e.amount?.toFixed(2)}</td>
                        <td>{e.currency}</td>
                        <td><span className="badge">{e.category}</span></td>
                        <td>{e.notes}</td>
                        <td>
                          <button onClick={() => { setEditId(e.id); setEditData({ ...e }) }} className="btn-small">Edit</button>
                          <button onClick={() => deleteExpense(e.id)} className="btn-small btn-danger">Delete</button>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </div>
  )
}
