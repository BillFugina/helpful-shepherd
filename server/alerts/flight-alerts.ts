import { and, eq, inArray, isNull } from 'drizzle-orm'
import { formatTime, THEATRE_TZ } from '../../shared/time.js'
import type { FlightDirection, FlightEventKind } from '../../shared/travel.js'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import { engagement, flight, flightEvent, person, production } from '../db/schema.js'
import { sendEmail, type Delivery } from '../email/send.js'
import type { PushNotice } from '../push/send.js'
import { shortName } from '../travel/records.js'
import { companyManagers, greeting } from './recipients.js'

/** The changes worth an email. "In the air" shows on the board only. */
export const ALERT_KINDS = [
  'delayed',
  'gate_change',
  'cancelled',
  'landed',
] as const satisfies readonly FlightEventKind[]
const isAlertKind = (k: FlightEventKind) => (ALERT_KINDS as readonly FlightEventKind[]).includes(k)

/** A change older than this (in the feed's time) is marked done without an email: it's no longer news. */
export const ALERT_FRESH_MS = 6 * 60 * 60 * 1000

export interface AlertItem {
  kind: FlightEventKind
  detail: Record<string, unknown> | null
  name: string
  production: string
  airline: string
  flightNumber: string
  direction: FlightDirection
  fromAirport: string
  toAirport: string
  scheduledDeparture: Date
  scheduledArrival: Date
  liveDeparture: Date | null
  liveArrival: Date | null
}

/** One line per change: who, which flight, and what happened. No contact details or booking codes. */
export function describeAlert(a: AlertItem): string {
  const arriving = a.direction === 'arrival'
  const who = `${a.name} (${a.production}), ${a.airline} ${a.flightNumber} ${arriving ? `from ${a.fromAirport}` : `to ${a.toAirport}`}`
  const time = (d: Date) => formatTime(d, THEATRE_TZ)
  switch (a.kind) {
    case 'delayed': {
      const minutes = Number(a.detail?.minutes ?? 0)
      const when = arriving
        ? `now lands at ${time(a.liveArrival ?? a.scheduledArrival)}`
        : `now leaves at ${time(a.liveDeparture ?? a.scheduledDeparture)}`
      return `${who}: late by ${minutes} min, ${when}.`
    }
    case 'gate_change':
      return `${who}: gate changed from ${String(a.detail?.from ?? '?')} to ${String(a.detail?.to ?? '?')}.`
    case 'cancelled':
      return `${who}: cancelled. They'll need a new flight.`
    case 'landed': {
      const bags = a.detail?.baggage ? `, bags at claim ${String(a.detail.baggage)}` : ''
      return arriving
        ? `${who}: landed at ${time(a.liveArrival ?? a.scheduledArrival)}${bags}.`
        : `${who}: landed at ${a.toAirport}.`
    }
    default:
      return `${who}: ${a.kind}.`
  }
}

const SUBJECT: Partial<Record<FlightEventKind, string>> = {
  delayed: 'flight is delayed',
  gate_change: 'flight has a new gate',
  cancelled: 'flight is cancelled',
  landed: 'flight has landed',
}

export function flightAlertEmail(input: {
  recipientName: string
  items: readonly AlertItem[]
  boardUrl: string
  simulated: boolean
}): { subject: string; text: string } {
  const { items } = input
  const first = items[0]!
  const subject =
    items.length === 1 ? `${first.name}'s ${SUBJECT[first.kind] ?? 'flight changed'}` : `${items.length} flight updates`
  const text = [
    greeting(input.recipientName),
    '',
    items.length === 1 ? 'A flight just changed:' : 'These flights just changed:',
    '',
    ...items.map((i) => `- ${describeAlert(i)}`),
    '',
    `Arrivals board: ${input.boardUrl}`,
    '',
    input.simulated
      ? 'Sent by the theatre app’s flight check. This demo uses a simulated flight feed, so these flights aren’t real.'
      : 'Sent by the theatre app’s flight check.',
  ].join('\n')
  return { subject, text }
}

/** Changes listed in a phone alert before it says how many more there are. */
const PUSH_LINES = 4

/** The phone alert for the same changes: the email's subject as the title, one line per change. */
export function flightAlertPush(input: { items: readonly AlertItem[]; simulated: boolean }): PushNotice {
  const { items } = input
  const first = items[0]!
  const title =
    items.length === 1 ? `${first.name}'s ${SUBJECT[first.kind] ?? 'flight changed'}` : `${items.length} flight updates`
  const lines = items.slice(0, PUSH_LINES).map(describeAlert)
  if (items.length > PUSH_LINES) lines.push(`And ${items.length - PUSH_LINES} more on the Arrivals board.`)
  if (input.simulated) lines.push('Simulated demo flights, not real ones.')
  return { title, body: lines.join('\n'), path: '/arrivals' }
}

interface ClaimedEvent {
  id: string
  flightId: string
  kind: FlightEventKind
  at: Date
  detail: Record<string, unknown> | null
}

/** Who and which flight for each change, in the order given. A change whose flight is gone is skipped. */
async function alertItems(db: Db, events: readonly ClaimedEvent[]): Promise<AlertItem[]> {
  if (!events.length) return []
  const rows = await db
    .select({
      flight,
      legalName: person.legalName,
      preferredName: person.preferredName,
      productionTitle: production.title,
    })
    .from(flight)
    .innerJoin(engagement, eq(engagement.id, flight.engagementId))
    .innerJoin(person, eq(person.id, engagement.personId))
    .innerJoin(production, eq(production.id, engagement.productionId))
    .where(inArray(flight.id, [...new Set(events.map((e) => e.flightId))]))
  const byFlight = new Map(rows.map((r) => [r.flight.id, r]))
  return events.flatMap((e) => {
    const r = byFlight.get(e.flightId)
    if (!r) return []
    const f = r.flight
    return [
      {
        kind: e.kind,
        detail: e.detail ?? null,
        name: shortName(r),
        production: r.productionTitle,
        airline: f.airline,
        flightNumber: f.flightNumber,
        direction: f.direction,
        fromAirport: f.fromAirport,
        toAirport: f.toAirport,
        scheduledDeparture: f.scheduledDeparture,
        scheduledArrival: f.scheduledArrival,
        liveDeparture: f.liveDeparture,
        liveArrival: f.liveArrival,
      },
    ]
  })
}

/**
 * The phone alert for changes an earlier step emailed, rebuilt from their ids
 * so the alert's names and flights never sit in the job's run history. Null
 * when none of them is left.
 */
export async function flightAlertNotice(
  db: Db,
  eventIds: readonly string[],
  simulated: boolean,
): Promise<PushNotice | null> {
  if (!eventIds.length) return null
  const rows = await db
    .select({
      id: flightEvent.id,
      flightId: flightEvent.flightId,
      kind: flightEvent.kind,
      at: flightEvent.at,
      detail: flightEvent.detail,
    })
    .from(flightEvent)
    .where(inArray(flightEvent.id, [...eventIds]))
  const order = new Map(eventIds.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const items = await alertItems(
    db,
    rows.map((r) => ({ ...r, detail: r.detail ?? null })),
  )
  return items.length ? flightAlertPush({ items, simulated }) : null
}

type Send = typeof sendEmail

export interface AlertRunResult {
  /** Changes emailed this run. */
  alerts: number
  /** What happened to each email, counted. */
  deliveries: Partial<Record<Delivery | 'failed', number>>
  /**
   * The changes emailed, by id, for the next step to push. Ids only: this is
   * kept in the job's run history, so no names or flights go in it.
   */
  eventIds: string[]
}

/**
 * Emails the Company Manager what changed since the last run, one email per
 * run. Each change is claimed first (alerted_at), so two runs at once can't
 * send it twice. If every email fails, the claim is undone and this throws, so
 * the scheduled job retries; if some went out, it isn't retried (no repeats).
 */
export async function sendFlightAlerts(
  db: Db,
  opts: { now: Date; origin: string; simulated: boolean; send?: Send },
): Promise<AlertRunResult> {
  const claimedAt = new Date()
  const claimed = await db
    .update(flightEvent)
    .set({ alertedAt: claimedAt })
    .where(isNull(flightEvent.alertedAt))
    .returning({
      id: flightEvent.id,
      flightId: flightEvent.flightId,
      kind: flightEvent.kind,
      at: flightEvent.at,
      detail: flightEvent.detail,
    })
  const fresh = claimed
    .filter((e) => isAlertKind(e.kind) && e.at.getTime() >= opts.now.getTime() - ALERT_FRESH_MS)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  if (!fresh.length) return { alerts: 0, deliveries: {}, eventIds: [] }

  const items = await alertItems(db, fresh)
  if (!items.length) return { alerts: 0, deliveries: {}, eventIds: [] }

  const recipients = await companyManagers(db, 'travel_logistics')
  const deliveries: AlertRunResult['deliveries'] = {}
  for (const r of recipients) {
    const { subject, text } = flightAlertEmail({
      recipientName: r.name,
      items,
      boardUrl: `${opts.origin}/arrivals`,
      simulated: opts.simulated,
    })
    let outcome: Delivery | 'failed'
    try {
      outcome = (await (opts.send ?? sendEmail)({ to: r.email, subject, text }, { isDemo: false })).delivery
    } catch {
      outcome = 'failed'
    }
    deliveries[outcome] = (deliveries[outcome] ?? 0) + 1
  }

  if (recipients.length && deliveries.failed === recipients.length) {
    // Nothing went out: put the changes back so the retry sends them.
    await db
      .update(flightEvent)
      .set({ alertedAt: null })
      .where(
        and(
          inArray(
            flightEvent.id,
            fresh.map((e) => e.id),
          ),
          eq(flightEvent.alertedAt, claimedAt),
        ),
      )
    throw new Error('Flight alert emails all failed')
  }
  await recordAudit(db, {
    actorId: null,
    action: 'send',
    recordType: 'flight_alert',
    via: 'system',
    // Counts only: no names, flights or addresses.
    detail: { alerts: items.length, recipients: recipients.length, deliveries },
  })
  return { alerts: items.length, deliveries, eventIds: fresh.map((e) => e.id) }
}
