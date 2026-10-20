import { annotateBalanceSequence, diffTransactionSets, validateStatementTotals } from './duplicateDetection.js'

const CURRENCY = '\\b(HKD|USD|EUR|GBP|CNY|RMB|JPY|AUD|CAD|SGD|CHF|NZD|KRW)\\b'
const ACCOUNT_KIND = '\\b(current|checking|cheque|savings?|deposit|credit card)\\b'
const KNOWN_CURRENCY = new RegExp(CURRENCY, 'i')
const KIND = new RegExp(ACCOUNT_KIND, 'i')

// A portfolio summary may name several accounts, but it also prints amounts.
// Only a short, amount-free heading immediately above an activity table is
// evidence of a new ledger section.
export function accountHeading(text) {
  const label = String(text || '').replace(/\s+/g, ' ').trim()
  if (!label || label.length > 100 || /\d[\d,]*\.\d{2}/.test(label) || !KIND.test(label)) return null
  const currency = (label.match(KNOWN_CURRENCY)?.[1] ||
    label.match(/\b([A-Z]{3})\s+(?:current|checking|cheque|savings?|deposit|credit card)\b/i)?.[1] ||
    label.match(/\b(?:current|checking|cheque|savings?|deposit|credit card)(?: account)?\s*\(([A-Z]{3})\)/i)?.[1])?.toUpperCase() || null
  const rawKind = label.match(KIND)?.[1].toLowerCase()
  const accountType = /sav|deposit/.test(rawKind) ? 'savings' : rawKind === 'credit card' ? 'credit_card' : 'current'
  const key = `${currency || 'unknown'}:${accountType}:${label.toLowerCase()}`
  return { key, label, currency, accountType, supportedCurrency: currency ? KNOWN_CURRENCY.test(currency) : false }
}

export function checkAccountSections(sections, rows) {
  return sections.map(section => {
    const sectionRows = rows.filter(row => row.sectionKey === section.key)
    const totalsCheck = validateStatementTotals({
      openingBalance: section.openingBalance,
      closingBalance: section.closingBalance,
      rows: sectionRows,
    })
    const balanceChecks = annotateBalanceSequence(sectionRows).filter(row => row.balanceSequenceValid != null)
    return {
      ...section,
      rowCount: sectionRows.length,
      totalsCheck,
      balanceChecks: balanceChecks.length,
      balanceBreaks: balanceChecks.filter(row => row.balanceSequenceValid === false).length,
    }
  })
}

export function annotateAccountSections(rows) {
  const byKey = new Map()
  for (const row of rows) {
    const key = row.sectionKey || 'unidentified'
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(row)
  }
  const annotated = new Map([...byKey.values()].flatMap(group => annotateBalanceSequence(group).map(row => [row.sourceRowIndex, row])))
  return rows.map(row => annotated.get(row.sourceRowIndex))
}

export function validateSectionLayout(sections) {
  if (sections.some(section => section.supportedCurrency === false)) return 'An account section has an unknown or unsupported currency. No rows can be imported safely.'
  if (sections.some(section => section.key === 'unidentified')) return 'Some rows could not be assigned to an account section. This PDF needs a better layout reading before import.'
  if (sections.some(section => section.ambiguous)) return 'This PDF repeats an account heading after another section. The app cannot safely tell whether it is the same account; use separate bank exports.'
  return null
}

export function validateSectionMappings(sections, mappings, accounts) {
  const selected = sections
  if (!selected.length) return 'No account activity was found.'
  const layoutError = validateSectionLayout(selected)
  if (layoutError) return layoutError
  const mapped = selected.map(section => ({ section, account: accounts.find(account => account.id === mappings[section.key] && account.active !== false) }))
  if (mapped.some(({ account }) => !account)) return 'Choose an account for every section before importing.'
  if (mapped.some(({ section, account }) => section.currency && account.settlementCurrency !== section.currency)) return 'An account currency does not match its PDF section.'
  if (mapped.some(({ section, account }) => section.accountType === 'credit_card' ? account.sourceType !== 'credit_card' : account.sourceType !== 'bank')) return 'An account type does not match its PDF section.'
  if (mapped.some(({ section, account }) => account.ledgerType && section.accountType && account.ledgerType !== section.accountType)) return 'A current or savings account does not match its PDF section.'
  if (new Set(mapped.map(({ account }) => account.id)).size !== mapped.length) return 'Each section needs its own account.'
  if (mapped.some(({ account }) => account.ownershipType === 'personal')) return 'Multi-account PDFs containing personal accounts cannot be imported safely yet. Export separate statements from the bank.'
  return null
}

export function compareSavedAccountSections(sections, reparsedRows, storedRows, savedSections, exclusions = []) {
  const savedByKey = new Map(savedSections.map(section => [section.key, section]))
  const mappingMatches = sections.every(section => savedByKey.has(section.key)) &&
    savedSections.every(section => sections.some(parsed => parsed.key === section.key)) &&
    storedRows.every(row => {
      const mapped = savedByKey.get(row.statementSectionKey)
      return mapped && row.paymentAccountId === mapped.paymentAccountId && row.settlementCurrency === mapped.currency
    })
  const missingRows = [], extraRows = []
  let missingFromRecords = 0, extraInRecords = 0
  for (const section of sections) {
    const fresh = reparsedRows.filter(row => row.sectionKey === section.key)
    const saved = storedRows.filter(row => row.statementSectionKey === section.key)
    const diff = diffTransactionSets(fresh, saved)
    missingFromRecords += diff.missingFromRecords
    extraInRecords += diff.extraInRecords
    missingRows.push(...diff.missingRows.map(row => ({ ...row, sectionKey: section.key })))
    extraRows.push(...diff.extraRows.map(row => ({ ...row, sectionKey: section.key })))
  }
  const unassigned = storedRows.filter(row => !sections.some(section => section.key === row.statementSectionKey))
  extraInRecords += unassigned.length
  extraRows.push(...unassigned.slice(0, 20).map(row => ({ ...row, sectionKey: row.statementSectionKey || 'unassigned' })))
  const totalsMatch = sections.every(section => section.totalsCheck?.consistent !== false)
  const reviewedDiff = exclusions.length
    ? sections.map(section => diffTransactionSets(reparsedRows.filter(row => row.sectionKey === section.key), [
        ...storedRows.filter(row => row.statementSectionKey === section.key),
        ...exclusions.filter(row => row.sectionKey === section.key),
      ]))
    : []
  const reviewedConsistent = mappingMatches && totalsMatch && exclusions.length > 0 &&
    reviewedDiff.every(diff => diff.missingFromRecords === 0 && diff.extraInRecords === 0)
  return {
    mappingMatches, totalsMatch, missingFromRecords, extraInRecords,
    missingRows: missingRows.slice(0, 20), extraRows: extraRows.slice(0, 20),
    consistent: mappingMatches && totalsMatch && missingFromRecords === 0 && extraInRecords === 0,
    reviewedConsistent,
  }
}
