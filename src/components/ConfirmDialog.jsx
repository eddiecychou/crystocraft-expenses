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

  // A 3rd button (Apply + Suggest Rule, say) with a long merchant-name
  // label never fit the plain 320px 2-button box — buttons squished and
  // wrapped mid-word. Widen the box and stack the buttons full-width
  // instead of forcing them into one flex-end row whenever there's an
  // extra action.
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className={`confirm-box${onExtra ? ' confirm-box-wide' : ''}`} role="alertdialog" aria-modal="true" aria-describedby="confirm-dialog-message" onClick={e => e.stopPropagation()}>
        <p id="confirm-dialog-message">{message}</p>
        <div className={`confirm-actions${onExtra ? ' confirm-actions-stack' : ''}`}>
          <button ref={cancelRef} onClick={onCancel} className="btn-ghost">Cancel</button>
          {onExtra && <button onClick={onExtra} className={extraClassName}>{extraLabel}</button>}
          <button onClick={onConfirm} className={confirmClassName}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
