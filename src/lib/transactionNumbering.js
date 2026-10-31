const PREFIX_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/

export function normalizeTransactionPrefix(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function validateTransactionPrefix(value, accounts, accountId = null) {
  if (!PREFIX_PATTERN.test(value) || value.length > 32) return 'Use up to 32 letters, numbers, and single hyphens.'
  if (accounts.some(account => account.id !== accountId && account.transactionPrefix === value)) return 'Another account in this project already uses that prefix.'
  return ''
}

export function suggestTransactionPrefix({ projectName, institutionName, label, accountTail, ledgerType, sourceType }, accounts = [], accountId = null) {
  const project = normalizeTransactionPrefix(projectName).split('-')[0].slice(0, 3) || 'PRJ'
  const bank = normalizeTransactionPrefix(institutionName || label).split('-')[0].slice(0, 6) || 'BANK'
  const type = sourceType === 'credit_card' ? 'CARD' : ledgerType === 'savings' ? 'SAV' : ledgerType === 'current' ? 'CUR' : 'BANK'
  const tail = String(accountTail || '').replace(/\D/g, '').slice(-4)
  const base = [project, bank, type, tail].filter(Boolean).join('-')
  let candidate = base
  for (let suffix = 2; validateTransactionPrefix(candidate, accounts, accountId); suffix++) candidate = `${base}-${suffix}`
  return candidate
}

export function transactionNumber(prefix, sequence) {
  if (validateTransactionPrefix(prefix, []) || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid transaction number')
  return `${prefix}-${String(sequence).padStart(6, '0')}`
}

export function assignImportNumbers(writes, accountStates) {
  const next = new Map([...accountStates].map(([id, state]) => [id, { ...state }]))
  const numberedWrites = writes.map(({ ref, data }) => {
    if (!data.importId || data.transactionNumber) return { ref, data }
    const state = next.get(data.paymentAccountId)
    if (!state) throw new Error('Missing numbering account')
    state.sequence++
    return { ref, data: { ...data, transactionSequence: state.sequence, transactionNumber: transactionNumber(state.prefix, state.sequence) } }
  })
  return { writes: numberedWrites, next }
}

function sourceKey(row) {
  const text = String(row.rawRowText || '').replace(/\s+/g, ' ').trim()
  return [text || row.merchantRaw, row.transactionDate, row.settlementAmount, row.direction, row.balanceAfter].join('|')
}

// A parser repair may insert new rows, but an existing issued number can only
// move to the same printed row. Ambiguous repeats need individual review.
export function preserveReprocessedNumbers(oldRows, newRows) {
  const oldNumbered = oldRows.filter(row => row.transactionNumber)
  const byKey = new Map()
  newRows.forEach((row, index) => {
    const key = sourceKey(row)
    byKey.set(key, [...(byKey.get(key) || []), index])
  })
  const oldKeys = new Map()
  oldNumbered.forEach(row => oldKeys.set(sourceKey(row), [...(oldKeys.get(sourceKey(row)) || []), row]))
  const preserved = new Map()
  for (const [key, oldGroup] of oldKeys) {
    const newIndexes = byKey.get(key) || []
    if (newIndexes.length !== oldGroup.length) throw new Error('A numbered row changed during re-reading. Edit the saved row instead of replacing this statement automatically.')
    if (oldGroup.length === 1) {
      preserved.set(newIndexes[0], { id: oldGroup[0].id, transactionNumber: oldGroup[0].transactionNumber, transactionSequence: oldGroup[0].transactionSequence })
      continue
    }
    const newByIndex = new Map(newIndexes.map(index => [newRows[index].sourceRowIndex, index]))
    if (newByIndex.size !== newIndexes.length || oldGroup.some(row => !newByIndex.has(row.sourceRowIndex))) {
      throw new Error('Repeated numbered rows cannot be matched safely. Edit the saved rows instead of replacing this statement automatically.')
    }
    oldGroup.forEach(row => preserved.set(newByIndex.get(row.sourceRowIndex), { id: row.id, transactionNumber: row.transactionNumber, transactionSequence: row.transactionSequence }))
  }
  return preserved
}

export function sortRowsForNumbering(rows, imports) {
  const byId = new Map(imports.map(item => [item.id, item]))
  return [...rows].sort((a, b) =>
    (a.transactionDate || '').localeCompare(b.transactionDate || '') ||
    ((byId.get(a.importId)?.periodStart || '').localeCompare(byId.get(b.importId)?.periodStart || '')) ||
    (Number(a.sourceRowIndex ?? 0) - Number(b.sourceRowIndex ?? 0)) ||
    a.id.localeCompare(b.id))
}
