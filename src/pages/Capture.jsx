import { Link } from 'react-router-dom'
import { useProject } from '../contexts/ProjectContext'
import ProjectBanner from '../components/ProjectBanner'
import { ReceiptIcon, BankStatementIcon, ICON_STROKE_WIDTH } from '../icons'

// A dispatcher, not a new upload pipeline — each card routes to the
// existing upload flow for that source type (Upload for receipts,
// Payment Sources for bank/credit-card statements).
export default function Capture() {
  const { activeProject } = useProject()
  if (!activeProject) return <div className="page page-narrow"><p className="loading">Loading…</p></div>

  return (
    <div className="page page-narrow">
      <ProjectBanner />
      <h2>Add Receipt or Statement</h2>
      <p className="hint">Choose the document you want to add.</p>
      <div className="capture-cards">
        <Link to="/upload" className="capture-card">
          <ReceiptIcon className="capture-card-icon" size={28} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          <span>
            <span className="capture-card-title">Receipt</span>
            <span className="capture-card-sub">A purchase receipt, as a photo or PDF</span>
          </span>
        </Link>
        <Link to="/payment-sources" className="capture-card">
          <BankStatementIcon className="capture-card-icon" size={28} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          <span>
            <span className="capture-card-title">Bank or Credit Card Statement</span>
            <span className="capture-card-sub">Choose an account, then add a PDF or CSV statement</span>
          </span>
        </Link>
      </div>
    </div>
  )
}
