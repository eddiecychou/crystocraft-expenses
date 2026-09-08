import { useState } from 'react'
import { ELIGIBLE_TYPES_FOR_RECORD } from '../lib/accountCodes'

// Reusable Account Code assignment control (Finance repositioning MVP-3).
// Type-to-search instead of one giant <select> — per spec §7, a normal
// user shouldn't face a long chart-of-accounts list. Empty input shows
// "recently used" codes for this project+recordType (passed in by the
// caller, since computing it needs access to the record list this
// component doesn't otherwise touch).
//
// `value`: { accountCodeId, accountCode, accountName } | null
// `accountCodes`: full project chart (unfiltered — this component applies
//   the active + type-eligibility filter itself, so callers never have to
//   remember the spec's income-vs-expense type rule).
// `recentCodes`: same shape as accountCodes, already deduped/ordered by
//   the caller.
export default function AccountCodePicker({ accountCodes, recordType, value, onChange, recentCodes = [] }) {
  const [searchText, setSearchText] = useState('')
  const eligibleTypes = ELIGIBLE_TYPES_FOR_RECORD[recordType] || []
  const eligible = accountCodes.filter(c => c.active !== false && eligibleTypes.includes(c.type))

  if (value?.accountCodeId) {
    return (
      <span className="chip">
        {value.accountCode} · {value.accountName}
        <button type="button" onClick={() => onChange(null)} aria-label="Clear account code">×</button>
      </span>
    )
  }

  const q = searchText.trim().toLowerCase()
  const results = q
    ? eligible.filter(c => `${c.code} ${c.name}`.toLowerCase().includes(q))
    : recentCodes.filter(c => eligible.some(e => e.id === c.id))

  return (
    <div className="expense-search">
      <input
        type="text"
        placeholder="Search account code or name…"
        value={searchText}
        onChange={e => setSearchText(e.target.value)}
      />
      {(q || recentCodes.length > 0) && (
        <div className="expense-search-results">
          {!q && results.length > 0 && <p className="hint" style={{ margin: '4px 8px' }}>Recently used</p>}
          {results.length === 0 && <p className="hint">No matching account codes.</p>}
          {results.map(c => (
            <button key={c.id} type="button" className="expense-search-result" onClick={() => { onChange({ accountCodeId: c.id, accountCode: c.code, accountName: c.name }); setSearchText('') }}>
              {c.code} · {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
