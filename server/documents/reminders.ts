import { and, desc, eq, inArray } from 'drizzle-orm'
import { DOCUMENT_TYPE_LABELS, type DocumentType } from '../../shared/documents.js'
import type { Db } from '../db/client.js'
import { auditEvent } from '../db/schema.js'

/** The audit record type for a reminder. The log is also where "last reminded" comes from. */
export const REMINDER_RECORD = 'document_reminder'

/** A reminder that went out can't be sent again to the same person this soon. */
export const REMINDER_GAP_MS = 60 * 60 * 1000

/** Most people in one bulk send (a production has about five). */
export const MAX_BULK_REMINDERS = 50

export function reminderEmail(input: {
  firstName: string
  theatre: string
  productionTitle: string
  forms: readonly DocumentType[]
  url: string
  expiresAt: Date
  senderName: string
}): { subject: string; text: string } {
  const theatre = input.theatre.trim() || 'The theatre'
  const until = input.expiresAt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  })
  const list = input.forms.map((f) => `- ${DOCUMENT_TYPE_LABELS[f]}`).join('\n')
  const greeting = input.firstName ? `Hi ${input.firstName},` : 'Hi,'
  const text = [
    greeting,
    '',
    `${theatre} still needs ${input.forms.length === 1 ? 'this form' : 'these forms'} from you for ${input.productionTitle}:`,
    '',
    list,
    '',
    `You can upload ${input.forms.length === 1 ? 'it' : 'them'} here, no account needed:`,
    input.url,
    '',
    `The link works until ${until}. A PDF, or a clear photo of each form, is fine.`,
    '',
    'If you’ve already sent everything, thank you, and you can ignore this.',
    '',
    input.senderName.trim() || theatre,
    theatre,
  ].join('\n')
  return { subject: `Forms still needed for ${input.productionTitle}`, text }
}

/** When each engagement last got a reminder, from the audit log. */
export async function lastReminders(
  db: Db,
  engagementIds: readonly string[],
): Promise<Map<string, { at: Date; delivery: string }>> {
  const out = new Map<string, { at: Date; delivery: string }>()
  if (!engagementIds.length) return out
  const rows = await db
    .select({ recordId: auditEvent.recordId, at: auditEvent.at, detail: auditEvent.detail })
    .from(auditEvent)
    .where(and(eq(auditEvent.recordType, REMINDER_RECORD), inArray(auditEvent.recordId, [...engagementIds])))
    .orderBy(desc(auditEvent.at))
  for (const r of rows) {
    if (!r.recordId || out.has(r.recordId)) continue
    out.set(r.recordId, { at: r.at, delivery: String(r.detail?.delivery ?? 'logged') })
  }
  return out
}
