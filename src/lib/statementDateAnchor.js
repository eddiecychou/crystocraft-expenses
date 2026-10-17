const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

// A statement address can contain an earlier date-shaped fragment (for
// example "38 UNIT 1905"). Keep looking until a real calendar date appears.
export function findStatementAnchorDate(text) {
  const matches = text.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/g)
  for (const match of matches) {
    const month = MONTHS[match[2].slice(0, 3).toLowerCase()]
    if (month === undefined) continue
    const year = Number(match[3])
    const day = Number(match[1])
    const date = new Date(Date.UTC(year, month, day))
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day) return date
  }
  return null
}
