import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { formsToRemind } from '../../shared/documents.js'
import { recordAudit } from '../audit.js'
import { loadOrganization } from '../contracts/service.js'
import type { Db } from '../db/client.js'
import { auditEvent, engagement, person, production, uploadLink } from '../db/schema.js'
import { issueLink } from '../documents/links.js'
import { lastReminders, REMINDER_RECORD, reminderEmail } from '../documents/reminders.js'
import { loadChecklists } from '../documents/service.js'
import { deliveryDecision, sendEmail } from '../email/send.js'

/** Someone reminded by hand this recently isn't sent an automatic one on top. */
export const RECENT_REMINDER_MS = 24 * 60 * 60 * 1000

export interface PaperworkRun {
  /** Engagements looked at. */
  checked: number
  sent: number
  /** Not sent: email is off, the address can't get mail, or it isn't on the test list. */
  held: number
  failed: number
  /** Skipped: nothing missing, no address, already reminded. */
  skipped: number
}

/**
 * The automatic reminder for one production, run on its reminder day. Looks
 * at everyone fresh (forms that came in while the run slept are not asked
 * for again), and reminds each person at most once per first-rehearsal date,
 * so a run that's restarted or retried never emails anyone twice.
 *
 * The email and upload link are the same as a Company Manager's reminder.
 * A link is made only when the email will really go, so demo people and
 * addresses off the test list never get one; the log still says what would
 * have gone, for the morning digest.
 */
export async function remindProduction(db: Db, productionId: string, now = new Date()): Promise<PaperworkRun> {
  const out: PaperworkRun = { checked: 0, sent: 0, held: 0, failed: 0, skipped: 0 }
  const [prod] = await db
    .select({ title: production.title, rehearsalStart: production.rehearsalStart })
    .from(production)
    .where(eq(production.id, productionId))
    .limit(1)
  if (!prod?.rehearsalStart) return out
  const rehearsalStart = prod.rehearsalStart
  const rows = await db
    .select({
      id: engagement.id,
      personId: engagement.personId,
      contractType: engagement.contractType,
      isDemo: engagement.isDemo,
      legalName: person.legalName,
      preferredName: person.preferredName,
      email: person.email,
    })
    .from(engagement)
    .innerJoin(person, eq(person.id, engagement.personId))
    .where(eq(engagement.productionId, productionId))
  if (!rows.length) return out
  const ids = rows.map((r) => r.id)
  const checklists = await loadChecklists(db, rows)
  const already = await autoRemindedFor(db, ids, rehearsalStart)
  const recent = await lastReminders(db, ids)
  const org = await loadOrganization(db)
  const theatre = org.name ?? ''

  for (const row of rows) {
    out.checked++
    const forms = formsToRemind(checklists.get(row.id) ?? [])
    const to = row.email?.trim()
    const last = recent.get(row.id)
    if (
      !forms.length ||
      !to ||
      already.has(row.id) ||
      (last?.delivery === 'sent' && now.getTime() - last.at.getTime() < RECENT_REMINDER_MS)
    ) {
      out.skipped++
      continue
    }
    const log = (delivery: string, linkId?: string) =>
      recordAudit(db, {
        actorId: null,
        action: 'send',
        recordType: REMINDER_RECORD,
        recordId: row.id,
        personId: row.personId,
        fieldGroup: 'documents',
        via: 'system',
        // No address and no link: what was asked for, and what happened.
        detail: { auto: true, rehearsalStart, documentTypes: forms, delivery, ...(linkId ? { linkId } : {}) },
      })

    const decision = deliveryDecision(to, { isDemo: row.isDemo })
    if (decision) {
      await log(decision.delivery)
      out.held++
      continue
    }
    const link = await issueLink(db, null, row, forms)
    const firstName = row.preferredName?.trim() || row.legalName.trim().split(/\s+/)[0] || ''
    const email = reminderEmail({
      firstName,
      theatre,
      productionTitle: prod.title,
      forms,
      url: link.url,
      expiresAt: link.expiresAt,
      senderName: '',
    })
    try {
      await sendEmail({ to, ...email, replyTo: org.email }, { isDemo: row.isDemo })
    } catch (err) {
      console.error('automatic reminder: send failed', err instanceof Error ? err.message : err)
      await db.update(uploadLink).set({ revokedAt: new Date() }).where(eq(uploadLink.id, link.id))
      await log('failed')
      out.failed++
      continue
    }
    // One live link per person: the one in the email they just got.
    await db
      .update(uploadLink)
      .set({ revokedAt: new Date() })
      .where(and(eq(uploadLink.engagementId, row.id), isNull(uploadLink.revokedAt), ne(uploadLink.id, link.id)))
    await log('sent', link.id)
    out.sent++
  }
  return out
}

/** Engagements that already had their automatic reminder for this first-rehearsal date. */
async function autoRemindedFor(db: Db, engagementIds: string[], rehearsalStart: string): Promise<Set<string>> {
  const rows = await db
    .select({ recordId: auditEvent.recordId })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.recordType, REMINDER_RECORD),
        inArray(auditEvent.recordId, engagementIds),
        sql`${auditEvent.detail}->>'auto' = 'true'`,
        sql`${auditEvent.detail}->>'rehearsalStart' = ${rehearsalStart}`,
        // A failed send may be tried again by a later run.
        sql`coalesce(${auditEvent.detail}->>'delivery', '') <> 'failed'`,
      ),
    )
  return new Set(rows.map((r) => r.recordId!).filter(Boolean))
}
