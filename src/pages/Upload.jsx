import { useState, useRef } from 'react'
import { collection, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, auth, storage } from '../firebase'
import { CATEGORIES, CURRENCIES } from '../constants'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'

export default function Upload() {
  const { activeProject } = useProject()
  const [fileItems, setFileItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [results, setResults] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const fileRef = useRef()
  const scanMoreRef = useRef()
  const attachRef = useRef()
  const attachIdxRef = useRef(null)

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
            mimeType = 'image/png'
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

  function removeFile(name) {
    setFileItems(prev => prev.filter(f => f.name !== name))
  }

  function addManual() {
    const today = new Date().toISOString().slice(0, 10)
    setResults(prev => [...prev, { fileName: 'Manual Entry', date: today, vendor: '', amount: '', currency: 'HKD', category: 'Other', notes: '' }])
  }

  function update(i, field, value) {
    setResults(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
  }

  function remove(i) {
    setResults(prev => prev.filter((_, idx) => idx !== i))
  }

  function openAttach(i) {
    attachIdxRef.current = i
    attachRef.current.click()
  }

  async function handleAttach(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file || attachIdxRef.current === null) return
    const i = attachIdxRef.current
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    try {
      let base64, mimeType
      if (isPdf) {
        base64 = await toBase64(file)
        mimeType = 'application/pdf'
      } else {
        try { base64 = await compressImage(file); mimeType = 'image/png' }
        catch { base64 = await toBase64(file); mimeType = file.type || 'image/jpeg' }
      }
      update(i, 'fileItem', { name: file.name, base64, mimeType })
    } catch (err) {
      alert('Could not read file: ' + err.message)
    }
  }

  async function handleScanMore(e) {
    const files = Array.from(e.target.files).filter(validFile)
    e.target.value = ''
    if (!files.length) return
    setProcessing(true)
    for (const file of files) {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
      let item
      try {
        let base64, mimeType
        if (isPdf) {
          base64 = await toBase64(file)
          mimeType = 'application/pdf'
        } else {
          try { base64 = await compressImage(file); mimeType = 'image/jpeg' }
          catch { base64 = await toBase64(file); mimeType = file.type || 'image/jpeg' }
        }
        item = { name: file.name, base64, mimeType }
      } catch (err) {
        const msg = err.name === 'NotFoundError'
          ? 'File not available locally — if stored in iCloud, open it in Preview first to download it'
          : (err.message || 'Could not read file')
        setResults(prev => [...prev, { fileName: file.name, error: msg }])
        continue
      }
      try {
        const res = await fetch('/api/process-receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileData: item.base64, mimeType: item.mimeType }),
        })
        const data = await res.json()
        setFileItems(prev => [...prev, item])
        setResults(prev => [...prev, { ...data, fileName: item.name }])
      } catch (err) {
        setResults(prev => [...prev, { fileName: file.name, error: err.message || 'Failed to process' }])
      }
    }
    setProcessing(false)
  }

  async function saveAll() {
    setSaving(true)
    const uid = auth.currentUser.uid
    const email = auth.currentUser.email

    for (const r of results) {
      if (r.error) continue

      // Save expense first to get the Firestore document ID
      const docRef = await addDoc(collection(db, 'expenses'), {
        userId: uid,
        userEmail: email,
        projectId: activeProject?.id || '',
        date: r.date || '',
        vendor: r.vendor || '',
        amount: parseFloat(r.amount) || 0,
        currency: r.currency || 'HKD',
        category: r.category || 'Other',
        notes: r.notes || '',
        images: [],
        createdAt: serverTimestamp(),
      })

      // Upload image — prefer manually attached, fall back to scanned fileItem
      const fileItem = r.fileItem || fileItems.find(f => f.name === r.fileName)
      if (fileItem && !fileItem.error) {
        try {
          const ext = fileItem.mimeType === 'application/pdf' ? 'pdf' : fileItem.mimeType === 'image/png' ? 'png' : 'jpg'
          const path = `receipts/${uid}/${docRef.id}/image0.${ext}`
          const bytes = atob(fileItem.base64)
          const arr = new Uint8Array(bytes.length)
          for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
          const blob = new Blob([arr], { type: fileItem.mimeType })
          const storageRef = ref(storage, path)
          await uploadBytes(storageRef, blob, { contentType: fileItem.mimeType })
          const url = await getDownloadURL(storageRef)
          await updateDoc(doc(db, 'expenses', docRef.id), {
            images: [{ url, path, name: fileItem.name }],
          })
        } catch (err) {
          console.error('Image upload failed for', r.fileName, err)
          // Don't block saving if image upload fails
        }
      }
    }

    setSaving(false)
    window.scrollTo(0, 0)
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
      <ProjectBanner />
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
            <p className="hint">JPEG · PNG · WebP · HEIC · GIF · BMP · TIFF · PDF · Multiple files OK</p>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.heic,.heif,.pdf"
              onChange={handleChange}
              hidden
            />
          </div>

          <div style={{ textAlign: 'center', margin: '-8px 0 20px' }}>
            <button onClick={addManual} className="btn-ghost">+ Add Manually</button>
          </div>

          {loading && <p className="hint">Reading files…</p>}

          {fileItems.length > 0 && !loading && (
            <div className="file-list">
              <p>{fileItems.length} file(s) selected:</p>
              <ul>
                {fileItems.map(f => (
                  <li key={f.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <span style={{ flex: 1 }}>
                      {f.name}
                      {f.error && <div className="error-msg">{f.error}</div>}
                    </span>
                    <button onClick={() => removeFile(f.name)} className="btn-small btn-danger">Remove</button>
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
              <div className="result-card-header">
                <span className="result-filename">{r.fileName}</span>
                <button onClick={() => remove(i)} className="btn-small btn-danger">Remove</button>
              </div>
              {r.error
                ? <div className="error-msg">Could not extract: {r.error}</div>
                : (
                  <>
                    <div className="result-grid">
                      <label>
                        Date
                        <input type="date" value={r.date || ''} onChange={e => update(i, 'date', e.target.value)} />
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
                    <div className="attach-row">
                      {r.fileItem
                        ? <>
                            <span className="hint">📎 {r.fileItem.name}</span>
                            <button onClick={() => update(i, 'fileItem', null)} className="btn-small btn-ghost">Remove image</button>
                          </>
                        : !fileItems.find(f => f.name === r.fileName) && (
                            <button onClick={() => openAttach(i)} className="btn-ghost btn-small">📎 Attach Image</button>
                          )
                      }
                    </div>
                  </>
                )
              }
            </div>
          ))}
          <div className="action-row">
            <button onClick={saveAll} disabled={saving || processing} className="btn-primary">
              {saving ? 'Saving…' : 'Save All Expenses'}
            </button>
            <button onClick={() => scanMoreRef.current.click()} disabled={processing} className="btn-ghost">
              {processing ? 'Scanning…' : '+ Scan More'}
            </button>
            <button onClick={addManual} disabled={processing} className="btn-ghost">+ Add Manually</button>
            <button onClick={() => { setResults([]); setFileItems([]) }} className="btn-ghost">Cancel</button>
          </div>
          <input ref={scanMoreRef} type="file" multiple accept="image/*,.heic,.heif,.pdf" hidden onChange={handleScanMore} />
          <input ref={attachRef} type="file" accept="image/*,.heic,.heif,.pdf" hidden onChange={handleAttach} />
        </div>
      )}
    </div>
  )
}

function validFile(f) {
  const ext = f.name.split('.').pop().toLowerCase()
  return f.type.startsWith('image/') || f.type === 'application/pdf'
    || ['heic', 'heif'].includes(ext)
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
  const MAX = 2400
  let { width, height } = bitmap
  if (width > MAX || height > MAX) {
    if (width > height) { height = Math.round(height * MAX / width); width = MAX }
    else { width = Math.round(width * MAX / height); height = MAX }
  }
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, width, height)

  // Pre-process for OCR: grayscale + auto-levels contrast boost
  const imageData = ctx.getImageData(0, 0, width, height)
  applyOCRPreprocess(imageData.data)
  ctx.putImageData(imageData, 0, 0)

  // PNG is lossless — no compression artefacts around thin text strokes
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return bufToBase64(await blob.arrayBuffer())
}

function applyOCRPreprocess(data) {
  // Step 1: Convert to grayscale (strips colour noise, helps thermal receipts)
  for (let i = 0; i < data.length; i += 4) {
    const g = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
    data[i] = data[i + 1] = data[i + 2] = g
  }
  // Step 2: Auto-levels — sample every 4th pixel, clip 1% outliers, stretch to 0–255
  // On faded thermal paper this turns light grey text into solid black
  const samples = []
  for (let i = 0; i < data.length; i += 16) samples.push(data[i])
  samples.sort((a, b) => a - b)
  const clip = Math.floor(samples.length * 0.01)
  const lo = samples[clip]
  const hi = samples[samples.length - 1 - clip]
  const range = hi - lo || 1
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.min(255, Math.max(0, Math.round((data[i] - lo) / range * 255)))
    data[i] = data[i + 1] = data[i + 2] = v
  }
}
