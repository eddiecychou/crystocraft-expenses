// Renders the two checks process-receipt.js/process-invoice.js compute
// server-side (see LESSONS_LEARNED.md's "A deterministic invariant can
// validate an AI extraction" entry) — an arithmetic mismatch against the
// document's own printed subtotal/tax breakdown, and a field that doesn't
// appear to be grounded in the OCR transcript at all. Advisory only, same
// as the statement import panel's own totals-check message — never blocks
// saving, just tells the reviewer where to look twice. Shared across
// Upload.jsx/Income.jsx/Invoices.jsx since all three show the same
// `validation` shape from the two extraction edge functions.
const FIELD_LABELS = { vendor: 'vendor', amount: 'amount', counterpartyName: 'name' }

export default function ExtractionWarning({ validation }) {
  if (!validation) return null
  const { arithmeticMismatch, ungroundedFields } = validation
  const hasMismatch = arithmeticMismatch && !arithmeticMismatch.consistent
  const hasUngrounded = ungroundedFields?.length > 0
  if (!hasMismatch && !hasUngrounded) return null

  return (
    <div className="extraction-warning" style={{ marginTop: 8 }}>
      {hasMismatch && (
        <p style={{ margin: 0 }}>
          Total ({arithmeticMismatch.extracted.toFixed(2)}) differs from the extracted breakdown
          ({arithmeticMismatch.expected.toFixed(2)}) by {Math.abs(arithmeticMismatch.difference).toFixed(2)}. Check the printed charges and adjustments before saving.
        </p>
      )}
      {hasUngrounded && (
        <p style={{ margin: hasMismatch ? '4px 0 0' : 0 }}>
          Couldn't confirm the {ungroundedFields.map(f => FIELD_LABELS[f] || f).join('/')} was printed on the
          document — check before saving.
        </p>
      )}
    </div>
  )
}
