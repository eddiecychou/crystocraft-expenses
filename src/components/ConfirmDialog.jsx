import { useEffect, useRef } from 'react'

export default function ConfirmDialog({ message, onConfirm, onCancel, confirmLabel = 'Delete', confirmClassName = 'btn-danger', extraLabel, extraClassName = 'btn-ghost', onExtra }) {
  // Cancel gets initial focus, not the (often destructive) confirm action —
  // a stray Enter/Space right after the dialog opens should never confirm.
  const cancelRef = useRef()

  useEffect(() => {
    cancelRef.current?.focus()
    const onKeyDown = e => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-box" role="alertdialog" aria-modal="true" aria-describedby="confirm-dialog-message" onClick={e => e.stopPropagation()}>
        <p id="confirm-dialog-message">{message}</p>
        <div className="confirm-actions">
          <button ref={cancelRef} onClick={onCancel} className="btn-ghost">Cancel</button>
          {onExtra && <button onClick={onExtra} className={extraClassName}>{extraLabel}</button>}
          <button onClick={onConfirm} className={confirmClassName}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
