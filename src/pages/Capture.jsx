import { Link } from 'react-router-dom'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'

// A dispatcher, not a new upload pipeline — each card routes to the
// existing upload flow for that source type (Upload for receipts,
// Payment Sources for bank/credit-card statements). Exists mainly for
// mobile, where the bottom nav caps at 4 top-level destinations and
// "what do I tap to add something" needs to be a single obvious step
// rather than picking the right item out of a longer menu.
export default function Capture() {
  const { activeProject } = useProject()
  if (!activeProject) return <div className="page"><p className="loading">Loading…</p></div>

  return (
    <div className="page">
      <ProjectBanner />
      <h2>Capture</h2>
      <p className="hint">What are you adding?</p>
      <div className="capture-cards">
        <Link to="/upload" className="capture-card">
          <span className="capture-card-icon" aria-hidden="true">🧾</span>
          <span>
            <span className="capture-card-title">Upload Receipt</span>
            <span className="capture-card-sub">Photo or PDF — OCR reads the date, vendor, and amount</span>
          </span>
        </Link>
        <Link to="/payment-sources" className="capture-card">
          <span className="capture-card-icon" aria-hidden="true">🏦</span>
          <span>
            <span className="capture-card-title">Upload Bank Statement</span>
            <span className="capture-card-sub">CSV or PDF — imported transactions go to Reconciliation</span>
          </span>
        </Link>
        <Link to="/payment-sources" className="capture-card">
          <span className="capture-card-icon" aria-hidden="true">💳</span>
          <span>
            <span className="capture-card-title">Upload Credit Card Statement</span>
            <span className="capture-card-sub">CSV or PDF — imported transactions go to Reconciliation</span>
          </span>
        </Link>
      </div>
    </div>
  )
}
