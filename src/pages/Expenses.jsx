import { useState, useEffect } from 'react'
import { collection, query, where, orderBy, getDocs, doc, updateDoc, deleteDoc } from 'firebase/firestore'
import { db, auth } from '../firebase'

const CATEGORIES = ['Travel', 'Meals', 'Office', 'Software', 'Utilities', 'Other']
const CURRENCIES = ['HKD', 'RMB', 'USD', 'EUR', 'JPY', 'AUD', 'GBP', 'SGD', 'CAD', 'KRW', 'Other']

function Lightbox({ images, onClose }) {
  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-box" onClick={e => e.stopPropagation()}>
        <button className="lightbox-close" onClick={onClose}>✕</button>
        <h3 className="lightbox-title">Receipt{images.length > 1 ? 's' : ''}</h3>
        {images.map((img, i) => (
          <div key={i} className="lightbox-item">
            {img.name?.toLowerCase().endsWith('.pdf')
              ? <a href={img.url} target="_blank" rel="noreferrer" className="btn-primary">Open PDF ↗</a>
              : <img src={img.url} alt={img.name} className="lightbox-img" />
            }
            <div className="lightbox-name">{img.name}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Expenses() {
  const [expenses, setExpenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState(null)
  const [editData, setEditData] = useState({})
  const [viewImages, setViewImages] = useState(null)

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

  function startEdit(e) { setEditId(e.id); setEditData({ ...e }) }
  function upd(field, value) { setEditData(p => ({ ...p, [field]: value })) }

  if (loading) return <div className="loading">Loading…</div>

  if (expenses.length === 0) return (
    <div className="page"><h2>All Expenses</h2><p className="empty">No expenses yet.</p></div>
  )

  return (
    <div className="page">
      <h2>All Expenses</h2>

      {viewImages && <Lightbox images={viewImages} onClose={() => setViewImages(null)} />}

      {/* Desktop table */}
      <div className="table-wrap desktop-only">
        <table className="expense-table">
          <thead>
            <tr>
              <th>Date</th><th>Vendor</th><th>Amount</th><th>Currency</th>
              <th>Category</th><th>Notes</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {expenses.map(e => (
              <tr key={e.id}>
                {editId === e.id ? (
                  <>
                    <td><input type="date" value={editData.date || ''} onChange={ev => upd('date', ev.target.value)} /></td>
                    <td><input value={editData.vendor || ''} onChange={ev => upd('vendor', ev.target.value)} /></td>
                    <td><input type="number" min="0" step="0.01" value={editData.amount || ''} onChange={ev => upd('amount', ev.target.value)} /></td>
                    <td><select value={editData.currency} onChange={ev => upd('currency', ev.target.value)}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></td>
                    <td><select value={editData.category} onChange={ev => upd('category', ev.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></td>
                    <td><input value={editData.notes || ''} onChange={ev => upd('notes', ev.target.value)} /></td>
                    <td>
                      <button onClick={saveEdit} className="btn-small">Save</button>
                      <button onClick={() => setEditId(null)} className="btn-small btn-ghost">Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{e.date}</td><td>{e.vendor}</td><td>{e.amount?.toFixed(2)}</td>
                    <td>{e.currency}</td><td><span className="badge">{e.category}</span></td>
                    <td>{e.notes}</td>
                    <td>
                      {e.images?.length > 0 && (
                        <button onClick={() => setViewImages(e.images)} className="btn-small" title="View receipt">
                          📎 {e.images.length}
                        </button>
                      )}
                      <button onClick={() => startEdit(e)} className="btn-small">Edit</button>
                      <button onClick={() => deleteExpense(e.id)} className="btn-small btn-danger">Delete</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="mobile-only">
        {expenses.map(e => (
          <div key={e.id} className="expense-mob-card">
            {editId === e.id ? (
              <>
                <div className="result-grid">
                  <label>Date<input type="date" value={editData.date || ''} onChange={ev => upd('date', ev.target.value)} /></label>
                  <label>Vendor<input value={editData.vendor || ''} onChange={ev => upd('vendor', ev.target.value)} /></label>
                  <label>Amount<input type="number" min="0" step="0.01" value={editData.amount || ''} onChange={ev => upd('amount', ev.target.value)} /></label>
                  <label>Currency<select value={editData.currency} onChange={ev => upd('currency', ev.target.value)}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></label>
                  <label>Category<select value={editData.category} onChange={ev => upd('category', ev.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></label>
                  <label className="full-width">Notes<input value={editData.notes || ''} onChange={ev => upd('notes', ev.target.value)} /></label>
                </div>
                <div className="mob-card-actions">
                  <button onClick={saveEdit} className="btn-primary">Save</button>
                  <button onClick={() => setEditId(null)} className="btn-ghost">Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div className="mob-card-header">
                  <span className="mob-card-vendor">{e.vendor}</span>
                  <span className="mob-card-amount">{e.currency} {e.amount?.toFixed(2)}</span>
                </div>
                <div className="mob-card-sub">
                  <span className="mob-card-date">{e.date}</span>
                  <span className="badge">{e.category}</span>
                </div>
                {e.notes && <div className="mob-card-notes">{e.notes}</div>}
                <div className="mob-card-actions">
                  {e.images?.length > 0 && (
                    <button onClick={() => setViewImages(e.images)} className="btn-small">📎 {e.images.length}</button>
                  )}
                  <button onClick={() => startEdit(e)} className="btn-small">Edit</button>
                  <button onClick={() => deleteExpense(e.id)} className="btn-small btn-danger">Delete</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
