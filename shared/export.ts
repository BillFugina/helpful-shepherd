/**
 * The full data export: everything the theater keeps here, as one ZIP it can
 * take to another system. Shared by the server, which builds it, and the
 * Export page, which describes it. Source: Ash's PRD, Security and privacy
 * ("Data export, so the theater owns its data if it changes vendors").
 */
import { z } from 'zod'

export const exportInput = z.object({
  /**
   * Also include the masked groups (DOB, home address, TSA/KTN, frequent
   * flyer) and any tax and bank forms the app still holds, decrypted. Off by
   * default; the Export page asks a second time before sending true.
   */
  includeSensitive: z.boolean().default(false),
})
export type ExportInput = z.input<typeof exportInput>

/** One file per table in csv/, the same rows in data.json. */
export const EXPORT_TABLES = [
  { name: 'seasons', label: 'Seasons' },
  { name: 'productions', label: 'Productions' },
  { name: 'people', label: 'People' },
  { name: 'agents', label: 'Agents' },
  { name: 'engagements', label: 'Engagements (each person’s deal on a production)' },
  { name: 'conflicts', label: 'Conflicts' },
  { name: 'housing_needs', label: 'Housing needs' },
  { name: 'flights', label: 'Flights' },
  { name: 'flight_alerts', label: 'Flight changes the tracker saw' },
  { name: 'rental_cars', label: 'Rental cars' },
  { name: 'housing_places', label: 'Housing places' },
  { name: 'housing_rooms', label: 'Housing rooms' },
  { name: 'housing_stays', label: 'Who stays where' },
  { name: 'organization', label: 'Theatre details printed on contracts' },
  { name: 'contract_templates', label: 'Contract templates' },
  { name: 'contracts', label: 'Contracts' },
  { name: 'documents', label: 'Paperwork checklist' },
  { name: 'document_requirements', label: 'Forms each contract type needs' },
  { name: 'document_settings', label: 'Paperwork settings' },
  { name: 'reminder_settings', label: 'Reminder settings' },
  { name: 'drafts', label: 'Drafts from Claude' },
  { name: 'staff', label: 'Staff logins and roles' },
  { name: 'role_access', label: 'What each role can see' },
  { name: 'audit_log', label: 'Audit log' },
] as const
export type ExportTableName = (typeof EXPORT_TABLES)[number]['name']

/**
 * The export comes back through a Vercel function, which sends at most 4.5 MB,
 * and base64 adds a third. Files that would push the ZIP past this are left
 * out and listed in its README, to be opened from the app instead.
 */
export const MAX_EXPORT_BYTES = 3_200_000

export interface ExportSummary {
  fileName: string
  bytes: number
  includesSensitive: boolean
  tables: { name: ExportTableName; rows: number }[]
  files: number
  skippedFiles: { path: string; bytes: number }[]
}
