import { and, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { Grants } from '../../shared/access.js'
import { DOCUMENT_TYPE_LABELS, type DocumentType } from '../../shared/documents.js'
import { addDays, localDate, THEATRE_TZ } from '../../shared/time.js'
import { greeting, sees, type Recipient } from '../alerts/recipients.js'
import { companyManagers } from '../alerts/recipients.js'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import { auditEvent, contract, document, engagement, person, production } from '../db/schema.js'
import { REMINDER_RECORD } from '../documents/reminders.js'
import { sendEmail } from '../email/send.js'
import { contractLateOn, digestAt } from './schedule.js'
import { loadReminderSettings } from './settings.js'

/** The audit record for a digest that went out. Its record id is the day, so a day gets one digest. */
export const DIGEST_RECORD = 'daily_digest'
/** A digest never looks back further than this, even after a long quiet spell. */
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

interface Line {
  production: string
  name: string
  text: string
}

export interface DigestContent {
  reminders: Line[]
  received: Line[]
  sentBack: Line[]
  unsigned: (Line & { news: boolean })[]
  contractDays: number
}

const nameOf = (r: { preferredName: string | null; legalName: string }) => r.preferredName?.trim() || r.legalName

const forms = (types: readonly string[]) =>
  [...new Set(types)].map((t) => DOCUMENT_TYPE_LABELS[t as DocumentType] ?? t).join(', ')

/** Everything a digest could say for the window (since, now]. Names only, never a document's contents. */
export async function loadDigest(db: Db, since: Date, now: Date, contractDays: number): Promise<DigestContent> {
  // Automatic paperwork reminders.
  const reminderRows = await db
    .select({
      at: auditEvent.at,
      detail: auditEvent.detail,
      legalName: person.legalName,
      preferredName: person.preferredName,
      title: production.title,
    })
    .from(auditEvent)
    .innerJoin(engagement, sql`${engagement.id}::text = ${auditEvent.recordId}`)
    .innerJoin(person, eq(person.id, engagement.personId))
    .innerJoin(production, eq(production.id, engagement.productionId))
    .where(
      and(
        eq(auditEvent.recordType, REMINDER_RECORD),
        isNull(auditEvent.actorId),
        sql`${auditEvent.detail}->>'auto' = 'true'`,
        gt(auditEvent.at, since),
        lte(auditEvent.at, now),
      ),
    )
    .orderBy(production.title, person.legalName)
  const reminders = reminderRows.map((r) => {
    const delivery = String(r.detail?.delivery ?? '')
    const list = forms((r.detail?.documentTypes as string[] | undefined) ?? [])
    const what =
      delivery === 'sent'
        ? `emailed for ${list}`
        : delivery === 'failed'
          ? `the email failed (${list})`
          : `not emailed, the address can’t get email from the app yet (${list})`
    return { production: r.title, name: nameOf(r), text: what }
  })

  // Forms in by upload link, and forms Finance sent back.
  const docRows = await db
    .select({
      via: auditEvent.via,
      detail: auditEvent.detail,
      legalName: person.legalName,
      preferredName: person.preferredName,
      title: production.title,
      engagementId: engagement.id,
    })
    .from(auditEvent)
    .innerJoin(document, sql`${document.id}::text = ${auditEvent.recordId}`)
    .innerJoin(engagement, eq(engagement.id, document.engagementId))
    .innerJoin(person, eq(person.id, engagement.personId))
    .innerJoin(production, eq(production.id, engagement.productionId))
    .where(
      and(
        eq(auditEvent.recordType, 'document'),
        gt(auditEvent.at, since),
        lte(auditEvent.at, now),
        sql`(${auditEvent.via} = 'upload_link' and ${auditEvent.detail}->>'to' = 'received') or ${auditEvent.detail}->>'flagged' = 'true'`,
      ),
    )
    .orderBy(production.title, person.legalName)
  const group = (rows: typeof docRows) => {
    const byEngagement = new Map<string, { production: string; name: string; types: string[] }>()
    for (const r of rows) {
      const g = byEngagement.get(r.engagementId) ?? { production: r.title, name: nameOf(r), types: [] }
      g.types.push(String(r.detail?.documentType ?? ''))
      byEngagement.set(r.engagementId, g)
    }
    return [...byEngagement.values()].map((g) => ({ production: g.production, name: g.name, text: forms(g.types) }))
  }
  const received = group(docRows.filter((r) => r.via === 'upload_link' && r.detail?.flagged !== true))
  const sentBack = group(docRows.filter((r) => r.detail?.flagged === true))

  // Contracts out longer than the setting allows and still unsigned.
  const unsigned: DigestContent['unsigned'] = []
  if (contractDays > 0) {
    const today = localDate(now, THEATRE_TZ)
    const rows = await db
      .select({
        sentOn: contract.sentOn,
        sentAt: contract.sentAt,
        legalName: person.legalName,
        preferredName: person.preferredName,
        title: production.title,
      })
      .from(contract)
      .innerJoin(engagement, eq(engagement.id, contract.engagementId))
      .innerJoin(person, eq(person.id, engagement.personId))
      .innerJoin(production, eq(production.id, engagement.productionId))
      .where(and(eq(contract.status, 'sent'), lte(contract.sentOn, addDays(today, -contractDays))))
      .orderBy(contract.sentOn, production.title, person.legalName)
    for (const r of rows) {
      if (!r.sentOn) continue
      const late = contractLateOn(r.sentOn, contractDays)!
      // News: it turned late in this window, or was marked sent (with an old date) in it.
      const turned = digestAt(late).getTime()
      const news = (turned > since.getTime() && turned <= now.getTime()) || (r.sentAt?.getTime() ?? 0) > since.getTime()
      const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.sentOn}T00:00:00Z`)) / DAY_MS)
      unsigned.push({
        production: r.title,
        name: nameOf(r),
        text: `sent ${formatDay(r.sentOn)}, ${days} days ago`,
        news,
      })
    }
  }
  return { reminders, received, sentBack, unsigned, contractDays }
}

function formatDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** What this person may see of the digest: paperwork needs Documents, contracts need Contracts. */
export function visibleTo(content: DigestContent, grants: Grants): DigestContent {
  const docs = sees(grants, 'documents') && sees(grants, 'general')
  const contracts = sees(grants, 'contracts') && sees(grants, 'general')
  return {
    reminders: docs ? content.reminders : [],
    received: docs ? content.received : [],
    sentBack: docs ? content.sentBack : [],
    unsigned: contracts ? content.unsigned : [],
    contractDays: content.contractDays,
  }
}

/** Whether there's anything new: a quiet day sends no digest. A contract that was already late isn't news again. */
export function hasNews(c: DigestContent): boolean {
  return c.reminders.length + c.received.length + c.sentBack.length > 0 || c.unsigned.some((u) => u.news)
}

export function digestEmail(
  c: DigestContent,
  opts: { name: string; origin: string; day: string; preview?: boolean },
): { subject: string; text: string } {
  const section = (title: string, lines: Line[]) =>
    lines.length ? ['', title, ...lines.map((l) => `- ${l.name}, ${l.production}: ${l.text}`)] : []
  const sections = [
    ...section('Automatic paperwork reminders', c.reminders),
    ...section('Forms sent in by upload link', c.received),
    ...section('Forms Finance sent back', c.sentBack),
    ...section(`Contracts still unsigned after ${c.contractDays} days`, c.unsigned),
  ]
  const text = [
    greeting(opts.name),
    '',
    opts.preview
      ? 'Here’s a preview of your morning digest, covering the last 7 days.'
      : 'Here’s what’s new since the last digest.',
    ...(sections.length ? sections : ['', 'Nothing new to report.']),
    '',
    `Documents: ${opts.origin}/documents`,
    '',
    `Sent by the theatre app. Change these emails under Reminders: ${opts.origin}/settings/reminders`,
  ].join('\n')
  const date = new Date(`${opts.day}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
  return { subject: `${opts.preview ? 'Preview: ' : ''}Theatre digest for ${date}`, text }
}

/** When the last digest went, if there was one. */
async function lastDigest(db: Db): Promise<{ at: Date; day: string | null } | null> {
  const [row] = await db
    .select({ at: auditEvent.at, recordId: auditEvent.recordId })
    .from(auditEvent)
    .where(eq(auditEvent.recordType, DIGEST_RECORD))
    .orderBy(desc(auditEvent.at))
    .limit(1)
  return row ? { at: row.at, day: row.recordId } : null
}

export async function digestSentFor(db: Db, day: string): Promise<boolean> {
  const rows = await db
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(and(eq(auditEvent.recordType, DIGEST_RECORD), inArray(auditEvent.recordId, [day])))
    .limit(1)
  return rows.length > 0
}

export type DigestOutcome =
  | { status: 'off' | 'already_sent' | 'nothing_new' | 'no_recipients' }
  | { status: 'sent'; recipients: number; delivered: Record<string, number> }

/**
 * The morning digest for `day`: one email per Company Manager, covering what
 * happened since the last digest. Sent only when there's something new, and
 * at most once a day. Returns counts only, so no names reach run history.
 */
export async function sendDailyDigest(
  db: Db,
  opts: { day: string; now: Date; origin: string },
): Promise<DigestOutcome> {
  const settings = await loadReminderSettings(db)
  if (!settings.digestOn) return { status: 'off' }
  if (await digestSentFor(db, opts.day)) return { status: 'already_sent' }
  const last = await lastDigest(db)
  const floor = opts.now.getTime() - MAX_LOOKBACK_MS
  const since = new Date(Math.max(last?.at.getTime() ?? opts.now.getTime() - DAY_MS, floor))
  const content = await loadDigest(db, since, opts.now, settings.contractDaysAfter)
  if (!hasNews(content)) return { status: 'nothing_new' }
  const recipients: Recipient[] = await companyManagers(db, 'documents')
  const delivered: Record<string, number> = {}
  let count = 0
  for (const r of recipients) {
    const mine = visibleTo(content, r.grants)
    if (!hasNews(mine)) continue
    const email = digestEmail(mine, { name: r.name, origin: opts.origin, day: opts.day })
    try {
      const result = await sendEmail({ to: r.email, ...email }, { isDemo: false })
      delivered[result.delivery] = (delivered[result.delivery] ?? 0) + 1
    } catch (err) {
      console.error('digest: send failed', err instanceof Error ? err.message : err)
      delivered.failed = (delivered.failed ?? 0) + 1
    }
    count++
  }
  if (!count) return { status: 'no_recipients' }
  await recordAudit(db, {
    actorId: null,
    action: 'send',
    recordType: DIGEST_RECORD,
    recordId: opts.day,
    via: 'system',
    detail: { recipients: count, delivered },
  })
  return { status: 'sent', recipients: count, delivered }
}
