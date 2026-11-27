import { and, eq, gt, gte, inArray, lt, lte } from 'drizzle-orm'
import { dayBounds, formatDay, formatTime, THEATRE_TZ, zonedToUtc } from '../../shared/time.js'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import {
  auditEvent,
  engagement,
  flight,
  housingAssignment,
  housingRoom,
  housingUnit,
  person,
  production,
  rentalCar,
} from '../db/schema.js'
import { sendEmail, type Delivery } from '../email/send.js'
import { shortName } from '../travel/records.js'
import { companyManagers, greeting, sees } from './recipients.js'

/** The audit record type for a sent summary; one per production per day, which also stops repeats. */
export const SUMMARY_RECORD = 'arrival_summary'

const DAY_MS = 24 * 60 * 60 * 1000

export interface SummaryPerson {
  engagementId: string
  name: string
  role: string
  /**
   * The leg that lands in town, with its live landing time when the tracker has
   * one. Null when they're expected but no flight is logged.
   */
  flight: { airline: string; flightNumber: string; fromAirport: string; landsAt: Date; cancelled: boolean } | null
  car: { company: string; pickupAt: Date; pickupPlace: string | null } | null
  /** Place and room names only: never the address, door code or how to get in. */
  housing: { place: string; room: string } | null
}

export interface ProductionSummary {
  productionId: string
  title: string
  date: string
  people: SummaryPerson[]
}

/**
 * Everyone landing on a theater-local day, by production: their flight in,
 * car pickup that day, and where they sleep that night (place and room name).
 * People expected that day with no arriving flight logged are listed too.
 */
export async function arrivalsOn(db: Db, date: string): Promise<ProductionSummary[]> {
  const { start, end } = dayBounds(date, THEATRE_TZ)
  const legs = await db
    .select({
      engagementId: flight.engagementId,
      airline: flight.airline,
      flightNumber: flight.flightNumber,
      fromAirport: flight.fromAirport,
      scheduledArrival: flight.scheduledArrival,
      liveArrival: flight.liveArrival,
      liveStatus: flight.liveStatus,
    })
    .from(flight)
    .where(
      and(
        eq(flight.direction, 'arrival'),
        // A day either side, so a delay or early landing that moves a flight onto `date` is caught.
        gte(flight.scheduledArrival, new Date(start.getTime() - DAY_MS)),
        lt(flight.scheduledArrival, new Date(end.getTime() + DAY_MS)),
      ),
    )
  // The day is judged by the live landing time when the tracker has one.
  const landsAt = (l: (typeof legs)[number]) =>
    l.liveStatus !== 'cancelled' && l.liveArrival ? l.liveArrival : l.scheduledArrival
  const onDay = legs.filter((l) => landsAt(l) >= start && landsAt(l) < end)
  // A connection has two arriving legs; the one that lands last is the one into town.
  const lastLeg = new Map<string, (typeof legs)[number]>()
  for (const l of onDay) {
    const prev = lastLeg.get(l.engagementId)
    if (!prev || landsAt(prev) < landsAt(l)) lastLeg.set(l.engagementId, l)
  }

  const expected = await db
    .select({ id: engagement.id })
    .from(engagement)
    .where(and(eq(engagement.travelProvided, true), eq(engagement.preferredArrival, date)))
  const expectedIds = expected.map((e) => e.id).filter((id) => !lastLeg.has(id))
  const withAnyArrival = expectedIds.length
    ? await db
        .select({ engagementId: flight.engagementId })
        .from(flight)
        .where(and(eq(flight.direction, 'arrival'), inArray(flight.engagementId, expectedIds)))
    : []
  const noFlight = expectedIds.filter((id) => !withAnyArrival.some((f) => f.engagementId === id))

  const ids = [...lastLeg.keys(), ...noFlight]
  if (!ids.length) return []

  const people = await db
    .select({
      engagementId: engagement.id,
      role: engagement.role,
      legalName: person.legalName,
      preferredName: person.preferredName,
      productionId: production.id,
      title: production.title,
    })
    .from(engagement)
    .innerJoin(person, eq(person.id, engagement.personId))
    .innerJoin(production, eq(production.id, engagement.productionId))
    .where(inArray(engagement.id, ids))
  const cars = await db
    .select()
    .from(rentalCar)
    .where(and(inArray(rentalCar.engagementId, ids), gte(rentalCar.pickupAt, start), lt(rentalCar.pickupAt, end)))
  const stays = await db
    .select({ engagementId: housingAssignment.engagementId, place: housingUnit.name, room: housingRoom.name })
    .from(housingAssignment)
    .innerJoin(housingRoom, eq(housingRoom.id, housingAssignment.roomId))
    .innerJoin(housingUnit, eq(housingUnit.id, housingRoom.unitId))
    .where(
      and(
        inArray(housingAssignment.engagementId, ids),
        lte(housingAssignment.startsOn, date),
        gt(housingAssignment.endsOn, date),
      ),
    )

  const byProduction = new Map<string, ProductionSummary>()
  for (const p of people) {
    const leg = lastLeg.get(p.engagementId)
    const car = cars.find((c) => c.engagementId === p.engagementId)
    // The night of `date`: a stay that starts on or before it and ends after it.
    const stay = stays.find((s) => s.engagementId === p.engagementId)
    const entry: SummaryPerson = {
      engagementId: p.engagementId,
      name: shortName(p),
      role: p.role,
      flight: leg
        ? {
            airline: leg.airline,
            flightNumber: leg.flightNumber,
            fromAirport: leg.fromAirport,
            landsAt: landsAt(leg),
            cancelled: leg.liveStatus === 'cancelled',
          }
        : null,
      car: car ? { company: car.company, pickupAt: car.pickupAt, pickupPlace: car.pickupPlace } : null,
      housing: stay ? { place: stay.place, room: stay.room } : null,
    }
    const group = byProduction.get(p.productionId) ?? {
      productionId: p.productionId,
      title: p.title,
      date,
      people: [],
    }
    group.people.push(entry)
    byProduction.set(p.productionId, group)
  }
  const landing = (s: SummaryPerson) => s.flight?.landsAt.getTime() ?? Number.MAX_SAFE_INTEGER
  return [...byProduction.values()]
    .map((g) => ({ ...g, people: g.people.sort((a, b) => landing(a) - landing(b) || a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.title.localeCompare(b.title))
}

export function arrivalSummaryEmail(input: {
  recipientName: string
  summary: ProductionSummary
  showHousing: boolean
  boardUrl: string
}): { subject: string; text: string } {
  const { summary } = input
  const n = summary.people.length
  const day = formatDay(zonedToUtc(`${summary.date}T12:00`, THEATRE_TZ), THEATRE_TZ)
  const time = (d: Date) => formatTime(d, THEATRE_TZ)
  const line = (p: SummaryPerson) => {
    const parts = [
      !p.flight
        ? 'No flight logged yet.'
        : p.flight.cancelled
          ? `${p.flight.airline} ${p.flight.flightNumber} from ${p.flight.fromAirport} was cancelled. They need a new flight.`
          : `${p.flight.airline} ${p.flight.flightNumber} from ${p.flight.fromAirport}, lands ${time(p.flight.landsAt)}.`,
    ]
    if (p.car) {
      parts.push(
        `Car: ${p.car.company}, pickup ${time(p.car.pickupAt)}${p.car.pickupPlace ? ` at ${p.car.pickupPlace}` : ''}.`,
      )
    }
    if (input.showHousing) parts.push(p.housing ? `Staying: ${p.housing.place}, ${p.housing.room}.` : 'No room yet.')
    return `- ${p.name} (${p.role}): ${parts.join(' ')}`
  }
  const text = [
    greeting(input.recipientName),
    '',
    `Arriving tomorrow, ${day}, for ${summary.title}:`,
    '',
    ...summary.people.map(line),
    '',
    `Arrivals board for that day: ${input.boardUrl}`,
  ].join('\n')
  return {
    subject: `Arriving tomorrow for ${summary.title}: ${n} ${n === 1 ? 'person' : 'people'}`,
    text,
  }
}

type Send = typeof sendEmail

export interface SummaryRunResult {
  date: string
  productions: number
  skipped: number
  deliveries: Partial<Record<Delivery | 'failed', number>>
}

/**
 * Emails the Company Manager one "arriving tomorrow" summary per production
 * with anyone landing on `date`. A production already summarized for that day
 * is skipped, so a retry or a second run never repeats it. If every email for
 * a production fails, this throws after trying the rest, so the job retries.
 */
export async function sendArrivalSummaries(
  db: Db,
  opts: { date: string; origin: string; send?: Send },
): Promise<SummaryRunResult> {
  const summaries = await arrivalsOn(db, opts.date)
  const result: SummaryRunResult = { date: opts.date, productions: 0, skipped: 0, deliveries: {} }
  if (!summaries.length) return result
  const recipients = await companyManagers(db, 'travel_logistics')
  if (!recipients.length) return result

  let failedProductions = 0
  for (const summary of summaries) {
    const recordId = `${summary.productionId}:${summary.date}`
    const [done] = await db
      .select({ id: auditEvent.id })
      .from(auditEvent)
      .where(and(eq(auditEvent.recordType, SUMMARY_RECORD), eq(auditEvent.recordId, recordId)))
      .limit(1)
    if (done) {
      result.skipped++
      continue
    }
    const deliveries: SummaryRunResult['deliveries'] = {}
    for (const r of recipients) {
      const { subject, text } = arrivalSummaryEmail({
        recipientName: r.name,
        summary,
        showHousing: sees(r.grants, 'housing'),
        boardUrl: `${opts.origin}/arrivals?date=${summary.date}`,
      })
      let outcome: Delivery | 'failed'
      try {
        outcome = (await (opts.send ?? sendEmail)({ to: r.email, subject, text }, { isDemo: false })).delivery
      } catch {
        outcome = 'failed'
      }
      deliveries[outcome] = (deliveries[outcome] ?? 0) + 1
      result.deliveries[outcome] = (result.deliveries[outcome] ?? 0) + 1
    }
    if (deliveries.failed === recipients.length) {
      failedProductions++
      continue
    }
    await recordAudit(db, {
      actorId: null,
      action: 'send',
      recordType: SUMMARY_RECORD,
      recordId,
      via: 'system',
      // Counts only: no names or addresses.
      detail: { people: summary.people.length, recipients: recipients.length, deliveries },
    })
    result.productions++
  }
  if (failedProductions) throw new Error('Arrival summary emails all failed for a production')
  return result
}
