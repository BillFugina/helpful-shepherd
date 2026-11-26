import { and, asc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm'
import { levelAtLeast, levelFor, type Grants } from '../../shared/access.js'
import {
  housingCoverage,
  housingMoves,
  housingNeed,
  type CoverageStatus,
  type HousingCoverage,
  type HousingMove,
  type HousingNeed,
} from '../../shared/travel.js'
import type { Db } from '../db/client.js'
import { engagement, flight, housingAssignment, housingRoom, housingUnit, person, production } from '../db/schema.js'
import { staysInWindow, visibleWarnings } from './housing.js'
import { shortName, travelDates } from './records.js'

/** One stay as the plan shows it: the place and room by name, never the address or how to get in. */
export interface PlanStay {
  assignmentId: string
  unitId: string
  unitName: string
  roomId: string
  roomName: string
  startsOn: string
  endsOn: string
}

export interface PlanPerson {
  engagementId: string
  personId: string
  name: string
  role: string
  productionId: string
  productionTitle: string
  housingProvided: boolean
  need: HousingNeed | null
  coverage: HousingCoverage
  stays: PlanStay[]
  /** Warnings on their stays (shared bathroom, floor, travel outside the stay). */
  warnings: string[]
}

export interface PlanProduction {
  id: string
  title: string
  rehearsalStart: string | null
  closing: string | null
}

/** Worst first, so the people who need something lead the list. */
const STATUS_ORDER: Record<CoverageStatus, number> = {
  unhoused: 0,
  partly_housed: 1,
  no_dates: 2,
  housed: 3,
  not_provided: 4,
}

export const needsAttention = (s: CoverageStatus) => s === 'unhoused' || s === 'partly_housed' || s === 'no_dates'

/**
 * Where everyone on these productions stays and who still needs a room.
 * The caller has checked the Housing and General groups. Flight dates only
 * shape the need when the role can see travel logistics; otherwise the dates
 * they asked for, then the production's, are used.
 */
export async function housingPlan(
  db: Db,
  grants: Grants,
  productionIds: readonly string[],
): Promise<{ productions: PlanProduction[]; people: PlanPerson[] }> {
  if (!productionIds.length) return { productions: [], people: [] }
  const productions = await db
    .select({
      id: production.id,
      title: production.title,
      rehearsalStart: production.rehearsalStart,
      closing: production.closing,
    })
    .from(production)
    .where(inArray(production.id, [...productionIds]))
    .orderBy(sql`${production.rehearsalStart} asc nulls last`, asc(production.title))

  const rows = await db
    .select({
      engagementId: engagement.id,
      personId: engagement.personId,
      productionId: engagement.productionId,
      role: engagement.role,
      housingProvided: engagement.housingProvided,
      preferredArrival: engagement.preferredArrival,
      preferredDeparture: engagement.preferredDeparture,
      legalName: person.legalName,
      preferredName: person.preferredName,
    })
    .from(engagement)
    .innerJoin(person, eq(person.id, engagement.personId))
    .where(inArray(engagement.productionId, [...productionIds]))
    .orderBy(asc(person.legalName))
  const engagementIds = rows.map((r) => r.engagementId)
  if (!engagementIds.length) return { productions, people: [] }

  const seesTravel = levelAtLeast(levelFor(grants, 'travel_logistics'), 'view')
  const flights = seesTravel
    ? await db
        .select({
          engagementId: flight.engagementId,
          direction: flight.direction,
          scheduledArrival: flight.scheduledArrival,
          scheduledDeparture: flight.scheduledDeparture,
        })
        .from(flight)
        .where(inArray(flight.engagementId, engagementIds))
    : []

  const stayRows = await db
    .select({
      assignmentId: housingAssignment.id,
      engagementId: housingAssignment.engagementId,
      startsOn: housingAssignment.startsOn,
      endsOn: housingAssignment.endsOn,
      roomId: housingRoom.id,
      roomName: housingRoom.name,
      unitId: housingUnit.id,
      unitName: housingUnit.name,
    })
    .from(housingAssignment)
    .innerJoin(housingRoom, eq(housingRoom.id, housingAssignment.roomId))
    .innerJoin(housingUnit, eq(housingUnit.id, housingRoom.unitId))
    .where(inArray(housingAssignment.engagementId, engagementIds))
    .orderBy(asc(housingAssignment.startsOn))

  // Warnings need everyone housed on those nights, not just these productions.
  const warningsByStay = new Map<string, string[]>()
  if (stayRows.length) {
    const from = stayRows.reduce((m, s) => (s.startsOn < m ? s.startsOn : m), stayRows[0]!.startsOn)
    const to = stayRows.reduce((m, s) => (s.endsOn > m ? s.endsOn : m), stayRows[0]!.endsOn)
    const { warnings } = await staysInWindow(db, from, to)
    for (const w of visibleWarnings(warnings, seesTravel))
      warningsByStay.set(w.assignmentId, [...(warningsByStay.get(w.assignmentId) ?? []), w.message])
  }

  const byProduction = new Map(productions.map((p) => [p.id, p]))
  const people: PlanPerson[] = rows.map((r) => {
    const p = byProduction.get(r.productionId)!
    const stays: PlanStay[] = stayRows
      .filter((s) => s.engagementId === r.engagementId)
      .map(({ engagementId: _e, ...s }) => s)
    const need = housingNeed({
      ...travelDates(flights.filter((f) => f.engagementId === r.engagementId)),
      preferredArrival: r.preferredArrival,
      preferredDeparture: r.preferredDeparture,
      rehearsalStart: p.rehearsalStart,
      closing: p.closing,
    })
    return {
      engagementId: r.engagementId,
      personId: r.personId,
      name: shortName(r),
      role: r.role,
      productionId: p.id,
      productionTitle: p.title,
      housingProvided: r.housingProvided,
      need,
      coverage: housingCoverage(r.housingProvided, need, stays),
      stays,
      warnings: stays.flatMap((s) => warningsByStay.get(s.assignmentId) ?? []),
    }
  })
  people.sort(
    (a, b) =>
      STATUS_ORDER[a.coverage.status] - STATUS_ORDER[b.coverage.status] ||
      (a.need?.from ?? '9999').localeCompare(b.need?.from ?? '9999') ||
      a.name.localeCompare(b.name),
  )
  return { productions, people }
}

/** Productions that haven't closed yet (or have no closing date), soonest first. */
export async function openProductionIds(db: Db, today: string): Promise<string[]> {
  const rows = await db
    .select({ id: production.id })
    .from(production)
    .where(or(sql`${production.closing} is null`, gte(production.closing, today)))
    .orderBy(sql`${production.rehearsalStart} asc nulls last`, asc(production.title))
  return rows.map((r) => r.id)
}

/** Everyone moving in or out of a room on a day in [from, to), with same-day turnovers marked. */
export async function movesInWindow(db: Db, from: string, to: string): Promise<HousingMove[]> {
  const rows = await db
    .select({
      assignmentId: housingAssignment.id,
      engagementId: housingAssignment.engagementId,
      roomId: housingAssignment.roomId,
      startsOn: housingAssignment.startsOn,
      endsOn: housingAssignment.endsOn,
      legalName: person.legalName,
      preferredName: person.preferredName,
    })
    .from(housingAssignment)
    .innerJoin(engagement, eq(engagement.id, housingAssignment.engagementId))
    .innerJoin(person, eq(person.id, engagement.personId))
    .where(
      or(
        and(gte(housingAssignment.startsOn, from), lt(housingAssignment.startsOn, to)),
        and(gte(housingAssignment.endsOn, from), lt(housingAssignment.endsOn, to)),
      ),
    )
  return housingMoves(
    rows.map((r) => ({ ...r, personName: shortName(r) })),
    from,
    to,
  )
}
