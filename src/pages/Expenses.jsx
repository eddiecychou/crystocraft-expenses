import { useState, useEffect, useRef } from 'react'
import { collection, query, where, orderBy, getDocs, doc, updateDoc, deleteDoc } from 'firebase/firestore'
import { db, auth, storage } from '../firebase'
import { ref, getBytes } from 'firebase/storage'
import { uploadReceiptImage, deleteReceiptImage, MAX_IMAGES } from '../receiptStorage'
import { CATEGORIES, CURRENCIES } from '../constants'

function Lightbox({ expenseId, images, onClose, onAdd, onDelete, uploading }) {
  const canAdd = images.length < MAX_IMAGES
  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-box" onClick={e => e.stopPropagation()}>
        <button className="lightbox-close" onClick={onClose}>✕</button>
        <h3 className="lightbox-title">
          Receipts ({images.length}/{MAX_IMAGES})
        </h3>

        {images.length === 0 && (
          <p className="hint" style={{ marginBottom: 16 }}>No images attached yet.</p>
        )}

        {images.map((img, i) => (
          <div key={i} className="lightbox-item">
            {img.name?.toLowerCase().endsWith('.pdf')
              ? <a href={img.url} target="_blank" rel="noreferrer" className="btn-primary">Open PDF ↗</a>
              : <img src={img.url} alt={img.name} className="lightbox-img" />
            }
            <div className="lightbox-item-footer">
              <span className="lightbox-name">{img.name}</span>
              <button onClick={() => onDelete(img)} className="btn-small btn-danger">Delete</button>
            </div>
          </div>
        ))}

        {canAdd && (
          <button onClick={onAdd} disabled={uploading} className="btn-ghost" style={{ width: '100%', marginTop: 8 }}>
            {uploading ? 'Uploading…' : '+ Add Photo'}
          </button>
        )}
        <button onClick={onClose} className="btn-primary" style={{ width: '100%', marginTop: 8 }}>Done</button>
      </div>
    </div>
  )
}

export default function Expenses() {
  const [expenses, setExpenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState(null)
  const [editData, setEditData] = useState({})
  const [viewImages, setViewImages] = useState(null) // { expenseId, images }
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef()
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [exportingXls, setExportingXls] = useState(false)
  const [exportingZip, setExportingZip] = useState(false)

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

  function openLightbox(e) {
    setViewImages({ expenseId: e.id, images: e.images || [] })
  }

  async function handleAddImage(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file || !viewImages) return
    const uid = auth.currentUser.uid
    const { expenseId, images } = viewImages
    if (images.length >= MAX_IMAGES) return
    setUploading(true)
    try {
      const img = await uploadReceiptImage(file, uid, expenseId, images.length)
      const newImages = [...images, img]
      await updateDoc(doc(db, 'expenses', expenseId), { images: newImages })
      setViewImages({ expenseId, images: newImages })
      load()
    } catch (err) {
      alert('Upload failed: ' + err.message)
    }
    setUploading(false)
  }

  async function handleDeleteImage(img) {
    if (!confirm('Delete this receipt image?')) return
    const { expenseId, images } = viewImages
    try { await deleteReceiptImage(img.path) } catch {}
    const newImages = images.filter(i => i.path !== img.path)
    await updateDoc(doc(db, 'expenses', expenseId), { images: newImages })
    setViewImages({ expenseId, images: newImages })
    load()
  }

  function startEdit(e) { setEditId(e.id); setEditData({ ...e }) }
  function upd(field, value) { setEditData(p => ({ ...p, [field]: value })) }

  async function exportExcel(rows) {
    setExportingXls(true)
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('Expense Records')
      ws.columns = [
        { header: 'Date',     key: 'date',     width: 13 },
        { header: 'Vendor',   key: 'vendor',   width: 26 },
        { header: 'Amount',   key: 'amount',   width: 12 },
        { header: 'Currency', key: 'currency', width: 10 },
        { header: 'Category', key: 'category', width: 14 },
        { header: 'Notes',    key: 'notes',    width: 32 },
        { header: 'Receipts', key: 'receipts', width: 50 },
      ]
      const hdr = ws.getRow(1)
      hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A5C38' } }

      for (const e of rows) {
        const urls = (e.images || []).map(img => img.url).join('\n')
        ws.addRow({ date: e.date, vendor: e.vendor, amount: e.amount, currency: e.currency, category: e.category, notes: e.notes || '', receipts: urls })
      }

      // Per-currency totals
      const totals = {}
      for (const e of rows) totals[e.currency] = (totals[e.currency] || 0) + (e.amount || 0)
      ws.addRow({})
      for (const [cur, total] of Object.entries(totals)) {
        const row = ws.addRow({ vendor: 'TOTAL', currency: cur, amount: parseFloat(total.toFixed(2)) })
        row.font = { bold: true }
      }

      const buf = await wb.xlsx.writeBuffer()
      triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `expense_records_${today()}.xlsx`)
    } catch (err) { alert('Export failed: ' + err.message) }
    setExportingXls(false)
  }

  async function exportZip(rows) {
    const withImages = rows.filter(e => e.images?.length > 0)
    if (withImages.length === 0) { alert('No receipt images in the current selection.'); return }
    setExportingZip(true)
    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      let added = 0
      const failures = []

      for (const e of withImages) {
        const ym = e.date ? e.date.slice(0, 7) : 'unknown'
        const base = `${e.date}_${sanitizeVendor(e.vendor)}_${(e.amount || 0).toFixed(2)}_${e.currency}`
        for (let i = 0; i < e.images.length; i++) {
          const img = e.images[i]
          const ext = img.path?.split('.').pop() || (img.name?.toLowerCase().endsWith('.pdf') ? 'pdf' : 'jpg')
          const suffix = e.images.length > 1 ? `_${i + 1}` : ''
          const filePath = `${ym}/${e.category}/${base}${suffix}.${ext}`
          try {
            const bytes = await getBytes(ref(storage, img.path))
            zip.file(filePath, bytes)
            added++
          } catch (err) {
            failures.push(`${e.vendor} (${e.date}): ${err.message}`)
          }
        }
      }

      if (added === 0) {
        alert('Could not download any receipt images.\n\n' + failures.join('\n'))
        setExportingZip(false)
        return
      }

      if (failures.length > 0) {
        console.warn('Some images could not be downloaded:', failures)
      }

      const blob = await zip.generateAsync({ type: 'blob' })
      triggerDownload(blob, `receipts_${today()}.zip`)
    } catch (err) { alert('Export failed: ' + err.message) }
    setExportingZip(false)
  }

  function sanitizeVendor(v) {
    return (v || 'unknown').replace(/ /g, '_').replace(/[/\\:*?"<>|]/g, '').trim() || 'unknown'
  }

  function today() { return new Date().toISOString().slice(0, 10) }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <div className="loading">Loading…</div>
  if (expenses.length === 0) return (
    <div className="page"><h2>Expense Records</h2><p className="empty">No expenses yet.</p></div>
  )

  const filtered = expenses.filter(e => {
    if (filterFrom && e.date < filterFrom) return false
    if (filterTo && e.date > filterTo) return false
    if (filterCategory && e.category !== filterCategory) return false
    return true
  })

  return (
    <div className="page">
      <h2>Expense Records</h2>

      <div className="filter-row">
        <div className="date-range">
          <input type="date" value={filterFrom} onChange={ev => setFilterFrom(ev.target.value)} placeholder="From" />
          <span style={{ padding: '0 4px', color: '#718096' }}>–</span>
          <input type="date" value={filterTo} onChange={ev => setFilterTo(ev.target.value)} placeholder="To" />
        </div>
        <select value={filterCategory} onChange={ev => setFilterCategory(ev.target.value)} style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #c6e0c0', fontSize: 14 }}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
        {(filterFrom || filterTo || filterCategory) && (
          <button className="btn-small btn-ghost" onClick={() => { setFilterFrom(''); setFilterTo(''); setFilterCategory('') }}>Clear</button>
        )}
      </div>

      {filtered.length > 0 && (
        <div className="export-row">
          <button onClick={() => exportExcel(filtered)} disabled={exportingXls || exportingZip} className="btn-small btn-ghost">
            {exportingXls ? 'Exporting…' : '⬇ Excel'}
          </button>
          <button onClick={() => exportZip(filtered)} disabled={exportingZip || exportingXls} className="btn-small btn-ghost">
            {exportingZip ? 'Zipping…' : '⬇ Receipt ZIP'}
          </button>
          <span className="hint">{filtered.length} record{filtered.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Hidden file input for adding images */}
      <input ref={fileInputRef} type="file" accept="image/*,.heic,.heif,.pdf" hidden onChange={handleAddImage} />

      {viewImages && (
        <Lightbox
          expenseId={viewImages.expenseId}
          images={viewImages.images}
          onClose={() => setViewImages(null)}
          onAdd={() => fileInputRef.current.click()}
          onDelete={handleDeleteImage}
          uploading={uploading}
        />
      )}

      {filtered.length === 0 && (
        <p className="empty">No expenses match your filters.</p>
      )}

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
            {filtered.map(e => (
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
                    <td>{e.currency}</td><td><span className={`badge badge-${e.category.toLowerCase()}`}>{e.category}</span></td>
                    <td>{e.notes}</td>
                    <td>
                      <button onClick={() => openLightbox(e)} className="btn-small" title="Manage receipts">
                        📎 {e.images?.length || 0}
                      </button>
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
        {filtered.map(e => (
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
                  <span className={`badge badge-${e.category.toLowerCase()}`}>{e.category}</span>
                </div>
                {e.notes && <div className="mob-card-notes">{e.notes}</div>}
                <div className="mob-card-actions">
                  <button onClick={() => openLightbox(e)} className="btn-small">
                    📎 {e.images?.length || 0}
                  </button>
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
