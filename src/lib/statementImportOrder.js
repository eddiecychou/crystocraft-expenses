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
