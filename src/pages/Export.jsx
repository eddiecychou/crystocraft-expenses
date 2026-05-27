import { useState } from 'react'
import { auth } from '../firebase'

export default function Export() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function downloadExcel() {
    setLoading(true)
    setError('')
    try {
      const idToken = await auth.currentUser.getIdToken()
      const res = await fetch('/api/export-excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Error ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `expenses-${new Date().toISOString().slice(0, 10)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page">
      <h2>Export</h2>
      <div className="card">
        <p>Download all your expenses as an Excel file — single running log, all transactions.</p>
        <button onClick={downloadExcel} disabled={loading} className="btn-primary">
          {loading ? 'Generating…' : '⬇ Download Excel (.xlsx)'}
        </button>
        {error && <div className="error-msg">{error}</div>}
      </div>
    </div>
  )
}
