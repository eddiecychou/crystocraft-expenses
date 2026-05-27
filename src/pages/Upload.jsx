import { useState, useRef } from 'react'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'

const CATEGORIES = ['Travel', 'Meals', 'Office', 'Software', 'Utilities', 'Other']
const CURRENCIES = ['HKD', 'RMB', 'USD', 'EUR', 'JPY', 'AUD', 'GBP', 'SGD', 'CAD', 'KRW', 'Other']

export default function Upload() {
  const [fileItems, setFileItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [results, setResults] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const fileRef = useRef()

  async function readFiles(rawFiles) {
    setLoading(true)
    setFileItems([])
    const items = []
    for (const file of rawFiles) {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
      try {
        let base64, mimeType
        if (isPdf) {
          base64 = await toBase64(file)
          mimeType = 'application/pdf'
        } else {
          try {
            base64 = await compressImage(file)
            mimeType = 'image/jpeg'
          } catch {
            base64 = await toBase64(file)
            mimeType = file.type || 'image/jpeg'
          }
        }
        items.push({ name: file.name, base64, mimeType })
      } catch (err) {
        const msg = err.name === 'NotFoundError'
          ? 'File not available locally — if stored in iCloud, open it in Preview first to download it'
          : (err.message || 'Could not read file')
        items.push({ name: file.name, error: msg })
      }
    }
    setFileItems(items)
    setLoading(false)
  }

  function handleDrop(e) {
    e.preventDefault()
    const dropped = Array.from(e.dataTransfer.files).filter(validFile)
    if (dropped.length) { readFiles(dropped); setResults([]); setSaved(false) }
  }

  function handleChange(e) {
    const selected = Array.from(e.target.files).filter(validFile)
    if (selected.length) { readFiles(selected); setResults([]); setSaved(false) }
  }

  async function processFiles() {
    setProcessing(true)
    const out = []
    for (const item of fileItems) {
      if (item.error) { out.push({ fileName: item.name, error: item.error }); continue }
      try {
        const res = await fetch('/api/process-receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileData: item.base64, mimeType: item.mimeType }),
        })
        const data = await res.json()
        out.push({ ...data, fileName: item.name })
      } catch (err) {
        out.push({ fileName: item.name, error: err.message || 'Failed to process' })
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
    setFileItems([])
    setResults([])
  }

  if (saved) return (
    <div className="page">
      <div className="success-msg">Expenses saved successfully!</div>
      <button onClick={() => setSaved(false)} className="btn-primary">Upload More</button>
    </div>
  )

  const hasReadable = fileItems.some(f => !f.error)

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

          {loading && <p className="hint">Reading files…</p>}

          {fileItems.length > 0 && !loading && (
            <div className="file-list">
              <p>{fileItems.length} file(s) selected:</p>
              <ul>
                {fileItems.map(f => (
                  <li key={f.name}>
                    {f.name}
                    {f.error && <div className="error-msg">{f.error}</div>}
                  </li>
                ))}
              </ul>
              {hasReadable && (
                <button onClick={processFiles} disabled={processing} className="btn-primary">
                  {processing ? 'Extracting data…' : 'Extract Data with AI'}
                </button>
              )}
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
            <button onClick={() => { setResults([]); setFileItems([]) }} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

function validFile(f) {
  return f.type.startsWith('image/') || f.type === 'application/pdf'
}

async function toBase64(file) {
  const buf = await file.arrayBuffer()
  return bufToBase64(buf)
}

function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file)
  const MAX = 1600
  let { width, height } = bitmap
  if (width > MAX || height > MAX) {
    if (width > height) { height = Math.round(height * MAX / width); width = MAX }
    else { width = Math.round(width * MAX / height); height = MAX }
  }
  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  return bufToBase64(await blob.arrayBuffer())
}
