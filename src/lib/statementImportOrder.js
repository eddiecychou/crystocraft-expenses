// Statement period is more useful than filename or upload order; incomplete
// attempts have no period yet, so show them by the time they were started.
export function sortStatementImports(imports) {
  const date = imp => imp.periodEnd || imp.createdAt?.toDate?.().toISOString().slice(0, 10) || ''
  return [...imports].sort((a, b) =>
    date(b).localeCompare(date(a)) ||
    (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0) ||
    (a.sourceFileName || '').localeCompare(b.sourceFileName || '')
  )
}

export function filterStatementImports(imports, accountId, from, to) {
  if (from && to && from > to) return []
  return imports.filter(imp => {
    if (accountId && imp.paymentAccountId !== accountId) return false
    if (!from && !to) return true
    const start = imp.periodStart || imp.periodEnd
    const end = imp.periodEnd || imp.periodStart
    if (!start || !end) return false
    return (!from || end >= from) && (!to || start <= to)
  })
}
