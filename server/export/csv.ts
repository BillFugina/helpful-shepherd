/**
 * CSV for spreadsheets (RFC 4180): comma separated, CRLF line ends, fields
 * quoted when they hold a comma, quote or line break. A text value that a
 * spreadsheet would run as a formula gets a leading apostrophe; data.json in
 * the same export keeps every value exactly as stored.
 */

const PLAIN_SIGNED_NUMBER = /^[+-][\d\s().-]*$/

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text: string
  if (value instanceof Date) text = value.toISOString()
  else if (typeof value === 'object') text = JSON.stringify(value)
  else text = String(value)
  if (typeof value === 'string' && needsFormulaGuard(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** =SUM(), @cmd and the like. A phone number like +1 919 555 0100 is left alone. */
function needsFormulaGuard(text: string): boolean {
  const first = text[0]
  if (first === '=' || first === '@' || first === '\t' || first === '\r') return true
  if (first === '+' || first === '-') return !PLAIN_SIGNED_NUMBER.test(text)
  return false
}

export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','))
  return lines.join('\r\n') + '\r\n'
}
