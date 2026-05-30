import { useState, useRef } from 'react'
import { collection, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, auth, storage } from '../firebase'
import { CATEGORIES, CURRENCIES } from '../constants'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import ConfirmDialog from '../components/ConfirmDialog'

export default function Upload() {
  const { activeProject } = useProject()
  const [fileItems, setFileItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [results, setResults] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [validationErrors, setValidationErrors] = useState({})
  const [confirmDialog, setConfirmDialog] = useState(null)
  const resultIdRef = useRef(0)
  const fileIdRef = useRef(0)
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
            mimeType = 'image/jpeg'
          } catch {
            base64 = await toBase64(file)
            mimeType = file.type || 'image/jpeg'
          }
        }
        items.push({ _id: ++fileIdRef.current, name: file.name, base64, mimeType })
      } catch (err) {
        const msg = err.name === 'NotFoundError'
          ? 'File not available locally — if stored in iCloud, open it in Preview first to download it'
          : (err.message || 'Could not read file')
        items.push({ _id: ++fileIdRef.current, name: file.name, error: msg })
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
      if (item.error) { out.push({ fileName: item.name, error: item.error, _id: ++resultIdRef.current }); continue }
      try {
        const ocr = await preprocessForGemini(item)
        const res = await fetch('/api/process-receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileData: ocr.base64, mimeType: ocr.mimeType }),
        })
        const data = await res.json()
        out.push({ ...data, fileName: item.name, _id: ++resultIdRef.current })
      } catch (err) {
        out.push({ fileName: item.name, error: err.message || 'Failed to process', _id: ++resultIdRef.current })
      }
    }
    setResults(out)
    setProcessing(false)
  }

  function removeFile(id) {
    setFileItems(prev => prev.filter(f => f._id !== id))
  }

  function addManual() {
    const today = new Date().toISOString().slice(0, 10)
    setResults(prev => [...prev, { fileName: 'Manual Entry', date: today, vendor: '', amount: '', currency: 'HKD', category: 'Other', notes: '', _id: ++resultIdRef.current }])
  }

  function update(id, field, value) {
    setResults(prev => prev.map(r => r._id === id ? { ...r, [field]: value } : r))
    // Clear the error for this field as the user corrects it
    if (['date', 'vendor', 'amount'].includes(field)) {
      setValidationErrors(prev => {
        const next = { ...prev }
        if (next[id]) next[id] = { ...next[id], [field]: false }
        return next
      })
    }
  }

  function remove(id) {
    setConfirmDialog({
      onConfirm: () => {
        setResults(prev => prev.filter(r => r._id !== id))
        setValidationErrors(prev => { const next = { ...prev }; delete next[id]; return next })
        setConfirmDialog(null)
      }
    })
  }

  function openAttach(id) {
    attachIdxRef.current = id
    attachRef.current.click()
  }

  async function handleAttach(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file || attachIdxRef.current === null) return
    const id = attachIdxRef.current
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    try {
      let base64, mimeType
      if (isPdf) {
        base64 = await toBase64(file)
        mimeType = 'application/pdf'
      } else {
        try { base64 = await compressImage(file); mimeType = 'image/jpeg' }
        catch { base64 = await toBase64(file); mimeType = file.type || 'image/jpeg' }
      }
      update(id, 'fileItem', { name: file.name, base64, mimeType })
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
        item = { _id: ++fileIdRef.current, name: file.name, base64, mimeType }
      } catch (err) {
        const msg = err.name === 'NotFoundError'
          ? 'File not available locally — if stored in iCloud, open it in Preview first to download it'
          : (err.message || 'Could not read file')
        setResults(prev => [...prev, { fileName: file.name, error: msg, _id: ++resultIdRef.current }])
        continue
      }
      try {
        const ocr = await preprocessForGemini(item)
        const res = await fetch('/api/process-receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileData: ocr.base64, mimeType: ocr.mimeType }),
        })
        const data = await res.json()
        setFileItems(prev => [...prev, item])
        setResults(prev => [...prev, { ...data, fileName: item.name, _id: ++resultIdRef.current }])
      } catch (err) {
        setResults(prev => [...prev, { fileName: file.name, error: err.message || 'Failed to process', _id: ++resultIdRef.current }])
      }
    }
    setProcessing(false)
  }

  async function saveAll() {
    const errs = {}
    for (const r of results) {
      if (r.error) continue
      const e = {
        date: !r.date,
        vendor: !r.vendor?.trim(),
        amount: !(parseFloat(r.amount) > 0),
      }
      if (e.date || e.vendor || e.amount) errs[r._id] = e
    }
    if (Object.keys(errs).length > 0) {
      setValidationErrors(errs)
      return
    }
    setValidationErrors({})
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
                  <li key={f._id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <span style={{ flex: 1 }}>
                      {f.name}
                      {f.error && <div className="error-msg">{f.error}</div>}
                    </span>
                    <button onClick={() => removeFile(f._id)} className="btn-small btn-danger">Remove</button>
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
            <div key={r._id} className="result-card">
              <div className="result-card-header">
                <span className="result-filename">{r.fileName}</span>
                <button onClick={() => remove(r._id)} className="btn-small btn-danger">Remove</button>
              </div>
              {r.error
                ? <div className="error-msg">Could not extract: {r.error}</div>
                : (
                  <>
                    <div className="result-grid">
                      <label>
                        Date
                        <input type="date" value={r.date || ''} onChange={e => update(r._id, 'date', e.target.value)} className={validationErrors[r._id]?.date ? 'input-error' : ''} />
                        {validationErrors[r._id]?.date && <span className="field-error-msg">Required</span>}
                      </label>
                      <label>
                        Vendor
                        <input value={r.vendor || ''} onChange={e => update(r._id, 'vendor', e.target.value)} className={validationErrors[r._id]?.vendor ? 'input-error' : ''} />
                        {validationErrors[r._id]?.vendor && <span className="field-error-msg">Required</span>}
                      </label>
                      <label>
                        Amount
                        <input type="number" step="0.01" value={r.amount || ''} onChange={e => update(r._id, 'amount', e.target.value)} className={validationErrors[r._id]?.amount ? 'input-error' : ''} />
                        {validationErrors[r._id]?.amount && <span className="field-error-msg">Required</span>}
                      </label>
                      <label>
                        Currency
                        <select value={r.currency || 'HKD'} onChange={e => update(r._id, 'currency', e.target.value)}>
                          {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                        </select>
                      </label>
                      <label>
                        Category
                        <select value={r.category || 'Other'} onChange={e => update(r._id, 'category', e.target.value)}>
                          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                        </select>
                      </label>
                      <label className="full-width">
                        Notes
                        <input value={r.notes || ''} onChange={e => update(r._id, 'notes', e.target.value)} />
                      </label>
                    </div>
                    <div className="attach-row">
                      {r.fileItem
                        ? <>
                            <span className="hint">📎 {r.fileItem.name}</span>
                            <button onClick={() => update(r._id, 'fileItem', null)} className="btn-small btn-ghost">Remove image</button>
                          </>
                        : !fileItems.find(f => f.name === r.fileName) && (
                            <button onClick={() => openAttach(r._id)} className="btn-ghost btn-small">📎 Attach Image</button>
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
          {confirmDialog && (
            <ConfirmDialog
              message="Remove this scan result?"
              confirmLabel="Remove"
              onConfirm={confirmDialog.onConfirm}
              onCancel={() => setConfirmDialog(null)}
            />
          )}
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
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.93 })
  return bufToBase64(await blob.arrayBuffer())
}

// Returns a high-contrast greyscale PNG for the Gemini API only.
// The original colour JPEG in fileItems is kept for Firebase Storage / display.
async function preprocessForGemini(item) {
  if (item.mimeType === 'application/pdf') return item
  try {
    const byteStr = atob(item.base64)
    const arr = new Uint8Array(byteStr.length)
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i)
    const bitmap = await createImageBitmap(new Blob([arr], { type: item.mimeType }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    applyOCRPreprocess(imageData.data)
    ctx.putImageData(imageData, 0, 0)
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' })
    return { base64: bufToBase64(await pngBlob.arrayBuffer()), mimeType: 'image/png' }
  } catch {
    return item // fall back to original if preprocessing fails
  }
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
