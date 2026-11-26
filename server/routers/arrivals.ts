import { and, asc, desc, eq, gte, inArray, lt, or } from 'drizzle-orm'
import { levelAtLeast, levelFor, type FieldGroup, type Grants } from '../../shared/access.js'
import { addDays, dayBounds, localDate, THEATRE_TZ } from '../../shared/time.js'
import { boardInput, setClockInput } from '../../shared/travel.js'
import type { Db } from '../db/client.js'
import {
  engagement,
  flight,
  flightEvent,
  housingAssignment,
  housingRoom,
  housingUnit,
  person,
  production,
  rentalCar,
} from '../db/schema.js'
import { flightProvider } from '../flights/provider.js'
import { replayFlight } from '../flights/replay.js'
import { clockOffsetMs, feedNow, setDemoClock, trackFlights } from '../flights/track.js'
import { shortName } from '../travel/records.js'
import { adminProcedure, router, staffProcedure } from '../trpc.js'
import { auditChange, requireEdit, requireView } from '../writes.js'

const can = (grants: Grants, group: FieldGroup) => levelAtLeast(levelFor(grants, group), 'view')

type FlightRow = typeof flight.$inferSelect

function flightView(f: FlightRow) {
  return {
    id: f.id,
    direction: f.direction,
    airline: f.airline,
    flightNumber: f.flightNumber,
    fromAirport: f.fromAirport,
    toAirport: f.toAirport,
    scheduledDeparture: f.scheduledDeparture,
    scheduledArrival: f.scheduledArrival,
    liveStatus: f.liveStatus,
    liveDeparture: f.liveDeparture,
    liveArrival: f.liveArrival,
    liveGate: f.liveGate,
    liveTerminal: f.liveTerminal,
    liveBaggage: f.liveBaggage,
    liveCheckedAt: f.liveCheckedAt,
  }
}

/** The first theater-local day, on or after `from`, with a flight leaving or landing. */
async function nextTravelDay(db: Db, from: string): Promise<string | null> {
  const { start } = dayBounds(from, THEATRE_TZ)
  const [arr] = await db
    .select({ at: flight.scheduledArrival })
    .from(flight)
    .where(and(eq(flight.direction, 'arrival'), gte(flight.scheduledArrival, start)))
    .orderBy(asc(flight.scheduledArrival))
    .limit(1)
  const [dep] = await db
    .select({ at: flight.scheduledDeparture })
    .from(flight)
    .where(and(eq(flight.direction, 'departure'), gte(flight.scheduledDeparture, start)))
    .orderBy(asc(flight.scheduledDeparture))
    .limit(1)
  const first = [arr?.at, dep?.at].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0]
  return first ? localDate(first, THEATRE_TZ) : null
}

export const arrivalsRouter = router({
  /**
   * The travel-day board: who lands and leaves on a theater-local day, with
   * live flight status, cars, where they sleep tonight, and alerts. Looking at
   * the board also runs the flight tracker (throttled per flight), until the
   * scheduled job exists.
   */
  board: staffProcedure.input(boardInput).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'travel_logistics')
    const provider = flightProvider()
    // A guest brings their own demo clock and never runs the tracker, which
    // writes: their board is worked out from the feed in memory (replayFlight).
    const guestClock = ctx.guest && provider.usesDemoClock ? input.clockOffsetMs : undefined
    const now = guestClock !== undefined ? new Date(Date.now() + guestClock) : await feedNow(ctx.db, provider)
    if (!ctx.guest) {
      try {
        await trackFlights(ctx.db, provider, now)
      } catch (error) {
        // The board still shows what it knows if the feed has a bad moment.
        console.error('flight tracker failed', error)
      }
    }

    const date = input.date ?? localDate(now, THEATRE_TZ)
    const { start, end } = dayBounds(date, THEATRE_TZ)
    const seeContact = can(ctx.grants, 'contact')
    const seeHousing = can(ctx.grants, 'housing_access')

    const stored = await ctx.db
      .select()
      .from(flight)
      .where(
        or(
          and(eq(flight.direction, 'arrival'), gte(flight.scheduledArrival, start), lt(flight.scheduledArrival, end)),
          and(
            eq(flight.direction, 'departure'),
            gte(flight.scheduledDeparture, start),
            lt(flight.scheduledDeparture, end),
          ),
        ),
      )
      .orderBy(asc(flight.scheduledArrival))
    const replays = ctx.guest ? new Map(stored.map((f) => [f.id, replayFlight(f, now)])) : null
    const flights = replays ? stored.map((f) => ({ ...f, ...replays.get(f.id)!.live })) : stored

    // Everyone expected that day, flight or not.
    const expected = await ctx.db
      .select({ id: engagement.id })
      .from(engagement)
      .where(
        and(
          eq(engagement.travelProvided, true),
          or(eq(engagement.preferredArrival, date), eq(engagement.preferredDeparture, date)),
        ),
      )
    const engagementIds = [...new Set([...flights.map((f) => f.engagementId), ...expected.map((e) => e.id)])]

    const people = engagementIds.length
      ? await ctx.db
          .select({
            engagementId: engagement.id,
            personId: person.id,
            legalName: person.legalName,
            preferredName: person.preferredName,
            cell: person.cell,
            role: engagement.role,
            pipelineStatus: engagement.pipelineStatus,
            travelProvided: engagement.travelProvided,
            preferredArrival: engagement.preferredArrival,
            preferredDeparture: engagement.preferredDeparture,
            productionTitle: production.title,
          })
          .from(engagement)
          .innerJoin(person, eq(person.id, engagement.personId))
          .innerJoin(production, eq(production.id, engagement.productionId))
          .where(inArray(engagement.id, engagementIds))
      : []

    // Which of them have any flight logged at all, in either direction.
    const allFlights = engagementIds.length
      ? await ctx.db
          .select({ engagementId: flight.engagementId, direction: flight.direction })
          .from(flight)
          .where(inArray(flight.engagementId, engagementIds))
      : []
    const hasLeg = (id: string, direction: 'arrival' | 'departure') =>
      allFlights.some((f) => f.engagementId === id && f.direction === direction)

    const cars = engagementIds.length
      ? await ctx.db
          .select()
          .from(rentalCar)
          .where(
            and(
              inArray(rentalCar.engagementId, engagementIds),
              or(
                and(gte(rentalCar.pickupAt, start), lt(rentalCar.pickupAt, end)),
                and(gte(rentalCar.returnAt, start), lt(rentalCar.returnAt, end)),
              ),
            ),
          )
      : []

    const tonight =
      seeHousing && engagementIds.length
        ? await ctx.db
            .select({
              engagementId: housingAssignment.engagementId,
              unitName: housingUnit.name,
              roomName: housingRoom.name,
              address: housingUnit.address,
              doorCode: housingUnit.doorCode,
              startsOn: housingAssignment.startsOn,
              endsOn: housingAssignment.endsOn,
            })
            .from(housingAssignment)
            .innerJoin(housingRoom, eq(housingRoom.id, housingAssignment.roomId))
            .innerJoin(housingUnit, eq(housingUnit.id, housingRoom.unitId))
            .where(
              and(
                inArray(housingAssignment.engagementId, engagementIds),
                lt(housingAssignment.startsOn, addDays(date, 1)),
                gte(housingAssignment.endsOn, date),
              ),
            )
        : []

    const flightIds = flights.map((f) => f.id)
    const alerts = replays
      ? [...replays]
          .flatMap(([flightId, r]) => r.events.map((e, i) => ({ event: { id: `${flightId}-${i}`, ...e }, flightId })))
          .sort((a, b) => b.event.at.getTime() - a.event.at.getTime())
          .slice(0, 30)
      : flightIds.length
        ? await ctx.db
            .select({ event: flightEvent, flightId: flight.id })
            .from(flightEvent)
            .innerJoin(flight, eq(flight.id, flightEvent.flightId))
            .where(inArray(flightEvent.flightId, flightIds))
            .orderBy(desc(flightEvent.at))
            .limit(30)
        : []

    const entry = (id: string) => {
      const p = people.find((x) => x.engagementId === id)!
      const stay = tonight.find((s) => s.engagementId === id && s.startsOn <= date && s.endsOn > date)
      return {
        engagementId: id,
        personId: p.personId,
        name: shortName(p),
        role: p.role,
        production: p.productionTitle,
        pipelineStatus: p.pipelineStatus,
        cell: seeContact ? p.cell : undefined,
        housingTonight: seeHousing
          ? stay
            ? {
                unit: stay.unitName,
                room: stay.roomName,
                address: stay.address,
                // Made up, but a public demo still shouldn't show one.
                doorCode: ctx.guest ? null : stay.doorCode,
              }
            : null
          : undefined,
      }
    }
    const byEngagement = (direction: 'arrival' | 'departure') => {
      const ids = [...new Set(flights.filter((f) => f.direction === direction).map((f) => f.engagementId))]
      return ids.map((id) => ({
        ...entry(id),
        legs: flights.filter((f) => f.engagementId === id && f.direction === direction).map(flightView),
        car: cars.find((c) => c.engagementId === id) ?? null,
      }))
    }
    const nameOf = new Map(people.map((p) => [p.engagementId, shortName(p)]))
    const flightOf = new Map(flights.map((f) => [f.id, f]))

    return {
      date,
      today: localDate(now, THEATRE_TZ),
      now,
      clock: {
        provider: provider.name,
        usesDemoClock: provider.usesDemoClock,
        offsetMs: !provider.usesDemoClock ? 0 : (guestClock ?? (await clockOffsetMs(ctx.db))),
      },
      arrivals: byEngagement('arrival'),
      departures: byEngagement('departure'),
      /** Expected to land today by their preferred dates, with no flight logged yet. */
      arrivingNoFlight: people
        .filter((p) => p.travelProvided && p.preferredArrival === date && !hasLeg(p.engagementId, 'arrival'))
        .map((p) => entry(p.engagementId)),
      leavingNoFlight: people
        .filter((p) => p.travelProvided && p.preferredDeparture === date && !hasLeg(p.engagementId, 'departure'))
        .map((p) => entry(p.engagementId)),
      alerts: alerts.map(({ event, flightId }) => {
        const f = flightOf.get(flightId)!
        return {
          id: event.id,
          at: event.at,
          kind: event.kind,
          detail: event.detail as Record<string, unknown> | null,
          flight: `${f.airline} ${f.flightNumber}`,
          direction: f.direction,
          engagementId: f.engagementId,
          name: nameOf.get(f.engagementId) ?? '',
        }
      }),
      nextTravelDay: await nextTravelDay(ctx.db, addDays(date, 1)),
      firstTravelDay: await nextTravelDay(ctx.db, localDate(now, THEATRE_TZ)),
    }
  }),

  /**
   * Moves the demo clock so a travel day can be replayed. Only for the
   * simulated feed; a real feed never follows it.
   */
  setClock: adminProcedure.input(setClockInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['travel_logistics'])
    const offsetMs = new Date(input.at).getTime() - Date.now()
    await setDemoClock(ctx.db, offsetMs)
    await auditChange(ctx.db, ctx.user, {
      action: 'update',
      recordType: 'demo_clock',
      recordId: 'demo',
      keys: [],
      fields: {},
      detail: { at: input.at },
    })
    return { offsetMs }
  }),

  resetClock: adminProcedure.mutation(async ({ ctx }) => {
    requireEdit(ctx.grants, ['travel_logistics'])
    await setDemoClock(ctx.db, 0)
    await auditChange(ctx.db, ctx.user, {
      action: 'update',
      recordType: 'demo_clock',
      recordId: 'demo',
      keys: [],
      fields: {},
      detail: { reset: true },
    })
    return { offsetMs: 0 }
  }),
})
