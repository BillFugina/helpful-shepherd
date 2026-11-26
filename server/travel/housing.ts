import { and, eq, gt, inArray, lt } from 'drizzle-orm'
import { housingWarnings, type HousingRule, type HousingWarning, type StayForCheck } from '../../shared/travel.js'
import type { Db } from '../db/client.js'
import { engagement, flight, housingAssignment, housingPreference, housingRoom, person } from '../db/schema.js'
import { shortName, travelDates } from './records.js'

const FLIGHT_WARNINGS = new Set<HousingWarning['kind']>(['arrives_before_housing', 'leaves_after_housing'])

/**
 * Warnings a role may see. The arrives-before and leaves-after warnings give
 * flight dates, so they need Travel logistics as well as Housing.
 */
export function visibleWarnings<W extends Pick<HousingWarning, 'kind'>>(warnings: W[], seesTravel: boolean): W[] {
  return seesTravel ? warnings : warnings.filter((w) => !FLIGHT_WARNINGS.has(w.kind))
}

export interface StaysResult {
  stays: StayForCheck[]
  warnings: HousingWarning[]
}

/**
 * Every stay with a night in [from, to), with the warnings that apply to it.
 * Warnings need the neighbors too (who else uses that bathroom), so this
 * always looks at every stay in the window, not just one person's.
 */
export async function staysInWindow(db: Db, from: string, to: string): Promise<StaysResult> {
  const rows = await db
    .select({
      assignment: housingAssignment,
      room: housingRoom,
      personId: engagement.personId,
      legalName: person.legalName,
      preferredName: person.preferredName,
    })
    .from(housingAssignment)
    .innerJoin(housingRoom, eq(housingRoom.id, housingAssignment.roomId))
    .innerJoin(engagement, eq(engagement.id, housingAssignment.engagementId))
    .innerJoin(person, eq(person.id, engagement.personId))
    .where(and(lt(housingAssignment.startsOn, to), gt(housingAssignment.endsOn, from)))

  const stays: StayForCheck[] = rows.map((r) => ({
    assignmentId: r.assignment.id,
    engagementId: r.assignment.engagementId,
    personId: r.personId,
    personName: shortName(r),
    unitId: r.room.unitId,
    roomId: r.room.id,
    roomName: r.room.name,
    floor: r.room.floor,
    bathroom: r.room.bathroom,
    startsOn: r.assignment.startsOn,
    endsOn: r.assignment.endsOn,
  }))
  if (!stays.length) return { stays, warnings: [] }

  const personIds = [...new Set(stays.map((s) => s.personId))]
  const engagementIds = [...new Set(stays.map((s) => s.engagementId))]
  const prefRows = await db
    .select({ personId: housingPreference.personId, rule: housingPreference.rule })
    .from(housingPreference)
    .where(inArray(housingPreference.personId, personIds))
  const rules = new Map<string, HousingRule[]>()
  for (const p of prefRows) rules.set(p.personId, [...(rules.get(p.personId) ?? []), p.rule])

  const flightRows = await db
    .select({
      engagementId: flight.engagementId,
      direction: flight.direction,
      scheduledArrival: flight.scheduledArrival,
      scheduledDeparture: flight.scheduledDeparture,
    })
    .from(flight)
    .where(inArray(flight.engagementId, engagementIds))
  const travel = new Map<string, { arrivesOn?: string; leavesOn?: string }>()
  for (const id of engagementIds) travel.set(id, travelDates(flightRows.filter((f) => f.engagementId === id)))

  return { stays, warnings: housingWarnings(stays, rules, travel) }
}

/** The first and last night of an engagement's stays, or null when they have none. */
export async function stayWindow(db: Db, engagementId: string): Promise<{ from: string; to: string } | null> {
  const rows = await db
    .select({ startsOn: housingAssignment.startsOn, endsOn: housingAssignment.endsOn })
    .from(housingAssignment)
    .where(eq(housingAssignment.engagementId, engagementId))
  if (!rows.length) return null
  return {
    from: rows.reduce((m, r) => (r.startsOn < m ? r.startsOn : m), rows[0]!.startsOn),
    to: rows.reduce((m, r) => (r.endsOn > m ? r.endsOn : m), rows[0]!.endsOn),
  }
}
