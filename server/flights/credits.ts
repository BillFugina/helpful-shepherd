import { and, eq, gte, sql } from 'drizzle-orm'
import { localDate, THEATRE_TZ, zonedToUtc } from '../../shared/time.js'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import { auditEvent } from '../db/schema.js'
import type { AdbClient } from './aerodatabox.js'

// Automatic top-up of AeroDataBox's alert credits. At zero AeroDataBox stops
// sending flight updates, so when the balance drops below a threshold the app
// adds credits on its own, up to a monthly cap. Each credit uses one API unit
// from the AeroDataBox plan. All three numbers can be changed in Vercel.

export interface TopUpSettings {
  /** Top up when the balance is below this. */
  below: number
  /** Credits added each time. */
  amount: number
  /** Most credits added automatically in a calendar month (theatre time). */
  monthlyMax: number
}

export const TOP_UP_DEFAULTS: TopUpSettings = { below: 100, amount: 500, monthlyMax: 10_000 }

function setting(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

/**
 * AERODATABOX_TOP_UP_BELOW, AERODATABOX_TOP_UP_AMOUNT and
 * AERODATABOX_TOP_UP_MONTHLY_MAX, each a whole number. A missing or
 * unreadable value uses the default. 0 for the amount or the cap turns
 * automatic top-up off.
 */
export function topUpSettings(e: NodeJS.ProcessEnv = process.env): TopUpSettings {
  return {
    below: setting(e.AERODATABOX_TOP_UP_BELOW, TOP_UP_DEFAULTS.below),
    amount: setting(e.AERODATABOX_TOP_UP_AMOUNT, TOP_UP_DEFAULTS.amount),
    monthlyMax: setting(e.AERODATABOX_TOP_UP_MONTHLY_MAX, TOP_UP_DEFAULTS.monthlyMax),
  }
}

export const topUpOn = (s: TopUpSettings) => s.amount > 0 && s.monthlyMax > 0

/** Where automatic top-ups are recorded: the audit log, with no actor. */
const AUTO = { recordType: 'flight_credits', recordId: 'aerodatabox' } as const

/** Midnight on the 1st of this month, theatre time. */
export function monthStart(now: Date): Date {
  return zonedToUtc(`${localDate(now, THEATRE_TZ).slice(0, 7)}-01T00:00`, THEATRE_TZ)
}

/** Credits added automatically so far this month. Top-ups by hand don't count. */
export async function autoTopUpsThisMonth(db: Db, now: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string | null>`sum((${auditEvent.detail}->>'added')::int)` })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.recordType, AUTO.recordType),
        eq(auditEvent.recordId, AUTO.recordId),
        sql`${auditEvent.detail}->>'auto' = 'true'`,
        gte(auditEvent.at, monthStart(now)),
      ),
    )
  return Number(row?.total ?? 0)
}

export type TopUpResult =
  | { action: 'off' | 'unknown'; credits: number | null }
  | { action: 'enough'; credits: number }
  | { action: 'capped'; credits: number; usedThisMonth: number }
  | { action: 'topped_up'; credits: number | null; added: number; usedThisMonth: number }

/**
 * Tops up the balance if it's below the threshold and the monthly cap has
 * room. Adds less than the usual amount when that's all the cap allows. Run
 * one at a time (the Inngest job has a concurrency of 1), so two can't both
 * fit under the cap.
 */
export async function autoTopUp(
  db: Db,
  api: AdbClient,
  now: Date,
  settings: TopUpSettings = topUpSettings(),
): Promise<TopUpResult> {
  const before = await api.balance()
  if (!topUpOn(settings)) return { action: 'off', credits: before }
  if (before === null) return { action: 'unknown', credits: null }
  if (before >= settings.below) return { action: 'enough', credits: before }
  const used = await autoTopUpsThisMonth(db, now)
  const add = Math.min(settings.amount, settings.monthlyMax - used)
  if (add <= 0) return { action: 'capped', credits: before, usedThisMonth: used }
  const after = await api.refill(add)
  await recordAudit(db, {
    actorId: null,
    action: 'update',
    ...AUTO,
    via: 'system',
    detail: { added: add, auto: true, before },
  })
  return { action: 'topped_up', credits: after, added: add, usedThisMonth: used + add }
}
