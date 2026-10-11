export default function FileUploadProgress({ label, percent }) {
  return (
    <div className="statement-batch-progress" role="status" aria-live="polite">
      <div className="statement-batch-progress-copy">{label} — {percent === 100 ? 'Finishing…' : `${percent}% uploaded`}</div>
      <div className="statement-batch-progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="statement-batch-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
