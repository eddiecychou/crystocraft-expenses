export default function ConfirmDialog({ message, onConfirm, onCancel, confirmLabel = 'Delete', confirmClassName = 'btn-danger' }) {
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-box" onClick={e => e.stopPropagation()}>
        <p>{message}</p>
        <div className="confirm-actions">
          <button onClick={onCancel} className="btn-ghost">Cancel</button>
          <button onClick={onConfirm} className={confirmClassName}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
