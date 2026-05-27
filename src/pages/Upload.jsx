import { useState, useRef } from 'react'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'

const CATEGORIES = ['Travel', 'Meals', 'Office', 'Software', 'Utilities', 'Other']
const CURRENCIES = ['HKD', 'RMB', 'USD', 'Other']

export default function Upload() {
  const [files, setFiles] = useState([])
  const [processing, setProcessing] = useState(false)
  const [results, setResults] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const fileRef = useRef()

  function handleDrop(e) {
    e.preventDefault()
    const dropped = Array.from(e.dataTransfer.files).filter(validFile)
    if (dropped.length) { setFiles(dropped); setResults([]); setSaved(false) }
  }

  function handleChange(e) {
    setFiles(Array.from(e.target.files))
    setResults([])
    setSaved(false)
  }

  async function processFiles() {
    setProcessing(true)
    const out = []
    for (const file of files) {
      try {
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
        const base64 = isPdf ? await toBase64(file) : await compressImage(file)
        const mimeType = isPdf ? 'application/pdf' : 'image/jpeg'
        const res = await fetch('/api/process-receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileData: base64, mimeType }),
        })
        const data = await res.json()
        out.push({ ...data, fileName: file.name })
      } catch (err) {
        out.push({ fileName: file.name, error: err.message || 'Failed to process' })
      }
    }
    setResults(out)
    setProcessing(false)
  }

  function update(i, field, value) {
    setResults(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
  }

  async function saveAll() {
    setSaving(true)
    const uid = auth.currentUser.uid
    const email = auth.currentUser.email
    for (const r of results) {
      if (r.error) continue
      await addDoc(collection(db, 'expenses'), {
        userId: uid,
        userEmail: email,
        date: r.date || '',
        vendor: r.vendor || '',
        amount: parseFloat(r.amount) || 0,
        currency: r.currency || 'HKD',
        category: r.category || 'Other',
        notes: r.notes || '',
        createdAt: serverTimestamp(),
      })
    }
    setSaving(false)
    setSaved(true)
    setFiles([])
    setResults([])
  }

  if (saved) return (
    <div className="page">
      <div className="success-msg">Expenses saved successfully!</div>
      <button onClick={() => setSaved(false)} className="btn-primary">Upload More</button>
    </div>
  )

  return (
    <div className="page">
      <h2>Upload Receipts</h2>

      {results.length === 0 && (
        <>
          <div
            className="dropzone"
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => fileRef.current.click()}
          >
            <div className="dropzone-icon">📄</div>
            <p>Drag & drop receipts here, or click to select</p>
            <p className="hint">JPEG · PNG · PDF · Multiple files OK</p>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.pdf"
              onChange={handleChange}
              hidden
            />
          </div>

          {files.length > 0 && (
            <div className="file-list">
              <p>{files.length} file(s) selected:</p>
              <ul>{files.map(f => <li key={f.name}>{f.name}</li>)}</ul>
              <button onClick={processFiles} disabled={processing} className="btn-primary">
                {processing ? 'Extracting data…' : 'Extract Data with AI'}
              </button>
            </div>
          )}
        </>
      )}

      {results.length > 0 && (
        <div>
          <h3>Review Extracted Data</h3>
          <p className="hint">Check and correct any fields before saving.</p>
          {results.map((r, i) => (
            <div key={i} className="result-card">
              <div className="result-filename">{r.fileName}</div>
              {r.error
                ? <div className="error-msg">Could not extract: {r.error}</div>
                : (
                  <div className="result-grid">
                    <label>
                      Date
                      <input value={r.date || ''} onChange={e => update(i, 'date', e.target.value)} placeholder="YYYY-MM-DD" />
                    </label>
                    <label>
                      Vendor
                      <input value={r.vendor || ''} onChange={e => update(i, 'vendor', e.target.value)} />
                    </label>
                    <label>
                      Amount
                      <input type="number" step="0.01" value={r.amount || ''} onChange={e => update(i, 'amount', e.target.value)} />
                    </label>
                    <label>
                      Currency
                      <select value={r.currency || 'HKD'} onChange={e => update(i, 'currency', e.target.value)}>
                        {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                      </select>
                    </label>
                    <label>
                      Category
                      <select value={r.category || 'Other'} onChange={e => update(i, 'category', e.target.value)}>
                        {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                      </select>
                    </label>
                    <label className="full-width">
                      Notes
                      <input value={r.notes || ''} onChange={e => update(i, 'notes', e.target.value)} />
                    </label>
                  </div>
                )
              }
            </div>
          ))}
          <div className="action-row">
            <button onClick={saveAll} disabled={saving} className="btn-primary">
              {saving ? 'Saving…' : 'Save All Expenses'}
            </button>
            <button onClick={() => { setResults([]); setFiles([]) }} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

function validFile(f) {
  return f.type.startsWith('image/') || f.type === 'application/pdf'
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result.split(',')[1])
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

// Resize image to max 1600px and compress to JPEG quality 0.85
// Keeps receipt text readable while staying under Netlify's 6MB body limit
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        const MAX = 1600
        let { width, height } = img
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width); width = MAX }
          else { width = Math.round(width * MAX / height); height = MAX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
      }
      img.onerror = reject
      img.src = e.target.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
