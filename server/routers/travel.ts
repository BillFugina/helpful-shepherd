import { TRPCError } from '@trpc/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { filterRecord, levelAtLeast, levelFor, type Grants } from '../../shared/access.js'
import { airportTz, THEATRE_TZ, zonedToUtc } from '../../shared/time.js'
import {
  addFlightInput,
  addRentalCarInput,
  FLIGHT_FIELDS,
  HOUSING_ASSIGNMENT_FIELDS,
  HOUSING_PREFERENCE_FIELDS,
  HOUSING_ROOM_FIELDS,
  HOUSING_UNIT_FIELDS,
  housingCoverage,
  housingNeed,
  RENTAL_CAR_FIELDS,
  updateFlightInput,
  updateRentalCarInput,
  type flightFields,
  type rentalCarFields,
} from '../../shared/travel.js'
import type { Db } from '../db/client.js'
import {
  engagement,
  flight,
  housingAssignment,
  housingPreference,
  housingRoom,
  housingUnit,
  person,
  production,
  rentalCar,
} from '../db/schema.js'
import { staysInWindow, stayWindow, visibleWarnings } from '../travel/housing.js'
import {
  flightRecord,
  housingAssignmentRecord,
  housingPreferenceRecord,
  housingRoomRecord,
  housingUnitRecord,
  rentalCarRecord,
  travelDates,
  withoutAccessForGuest,
} from '../travel/records.js'
import { router, staffProcedure } from '../trpc.js'
import { auditChange, friendly, requireEdit, requireView } from '../writes.js'

const can = (grants: Grants, group: Parameters<typeof levelFor>[1]) => levelAtLeast(levelFor(grants, group), 'view')

export async function engagementOrThrow(db: Db, id: string) {
  const [row] = await db.select().from(engagement).where(eq(engagement.id, id)).limit(1)
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That engagement no longer exists.' })
  return row
}

/** A flight form's local times, turned into instants at each airport. */
function flightColumns(input: z.output<typeof flightFields>) {
  return {
    direction: input.direction,
    airline: input.airline,
    flightNumber: input.flightNumber,
    fromAirport: input.fromAirport,
    toAirport: input.toAirport,
    scheduledDeparture: zonedToUtc(input.departLocal, airportTz(input.fromAirport)),
    scheduledArrival: zonedToUtc(input.arriveLocal, airportTz(input.toAirport)),
    confirmation: input.confirmation ?? null,
    bookingSource: input.bookingSource ?? null,
    notes: input.notes ?? null,
  }
}

/** Rental car times are typed in the theater's time zone. */
function carColumns(input: z.output<typeof rentalCarFields>) {
  return {
    company: input.company,
    confirmation: input.confirmation ?? null,
    pickupAt: zonedToUtc(input.pickupLocal, THEATRE_TZ),
    pickupPlace: input.pickupPlace ?? null,
    returnAt: zonedToUtc(input.returnLocal, THEATRE_TZ),
    returnPlace: input.returnPlace ?? null,
    notes: input.notes ?? null,
  }
}

/** Live status no longer applies once the booking changes; the tracker fills it in again. */
const CLEARED_LIVE = {
  liveStatus: null,
  liveDeparture: null,
  liveArrival: null,
  liveGate: null,
  liveTerminal: null,
  liveBaggage: null,
  liveCheckedAt: null,
} as const

const FLIGHT_FORM_KEYS = Object.keys(FLIGHT_FIELDS).filter(
  (k) => k !== 'id' && k !== 'engagementId' && !k.startsWith('live'),
)
const CAR_FORM_KEYS = Object.keys(RENTAL_CAR_FIELDS).filter((k) => k !== 'id' && k !== 'engagementId')

export const travelRouter = router({
  /**
   * One person's itinerary for one production: the person card and the
   * travel editor both read this. Each part comes back only when the role
   * can see its field group; a part it can't see is undefined.
   */
  forEngagement: staffProcedure.input(z.object({ engagementId: z.uuid() })).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'general')
    const [row] = await ctx.db
      .select({ engagement, person, production })
      .from(engagement)
      .innerJoin(person, eq(person.id, engagement.personId))
      .innerJoin(production, eq(production.id, engagement.productionId))
      .where(eq(engagement.id, input.engagementId))
      .limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That engagement no longer exists.' })
    const e = row.engagement
    const seesContact = can(ctx.grants, 'contact')
    const seesTravel = can(ctx.grants, 'travel_logistics')
    const seesHousing = can(ctx.grants, 'housing')

    const flights = seesTravel
      ? await ctx.db.select().from(flight).where(eq(flight.engagementId, e.id)).orderBy(asc(flight.scheduledDeparture))
      : null
    const cars = seesTravel
      ? await ctx.db.select().from(rentalCar).where(eq(rentalCar.engagementId, e.id)).orderBy(asc(rentalCar.pickupAt))
      : null

    let housing
    if (seesHousing) {
      const stays = await ctx.db
        .select({ assignment: housingAssignment, room: housingRoom, unit: housingUnit })
        .from(housingAssignment)
        .innerJoin(housingRoom, eq(housingRoom.id, housingAssignment.roomId))
        .innerJoin(housingUnit, eq(housingUnit.id, housingRoom.unitId))
        .where(eq(housingAssignment.engagementId, e.id))
        .orderBy(asc(housingAssignment.startsOn))
      const window = await stayWindow(ctx.db, e.id)
      const warnings = window
        ? visibleWarnings(
            (await staysInWindow(ctx.db, window.from, window.to)).warnings.filter((w) =>
              stays.some((s) => s.assignment.id === w.assignmentId),
            ),
            seesTravel,
          )
        : []
      const need = housingNeed({
        ...travelDates(flights ?? []),
        preferredArrival: e.preferredArrival,
        preferredDeparture: e.preferredDeparture,
        rehearsalStart: row.production.rehearsalStart,
        closing: row.production.closing,
      })
      housing = {
        need,
        coverage: housingCoverage(
          e.housingProvided,
          need,
          stays.map((s) => s.assignment),
        ),
        stays: stays.map((s) => ({
          ...filterRecord(housingAssignmentRecord(s.assignment), HOUSING_ASSIGNMENT_FIELDS, ctx.grants),
          room: filterRecord(housingRoomRecord(s.room), HOUSING_ROOM_FIELDS, ctx.grants),
          unit: withoutAccessForGuest(
            filterRecord(housingUnitRecord(s.unit), HOUSING_UNIT_FIELDS, ctx.grants),
            ctx.guest,
          ),
        })),
        warnings,
      }
    }

    const prefs = await ctx.db
      .select()
      .from(housingPreference)
      .where(eq(housingPreference.personId, e.personId))
      .orderBy(asc(housingPreference.rule))

    return {
      engagementId: e.id,
      seasonId: row.production.seasonId,
      production: { id: row.production.id, title: row.production.title },
      role: e.role,
      pipelineStatus: e.pipelineStatus,
      travelProvided: e.travelProvided,
      carProvided: e.carProvided,
      housingProvided: e.housingProvided,
      preferredArrival: e.preferredArrival,
      preferredDeparture: e.preferredDeparture,
      person: {
        id: row.person.id,
        legalName: row.person.legalName,
        preferredName: row.person.preferredName,
        cell: seesContact ? row.person.cell : undefined,
        email: seesContact ? row.person.email : undefined,
        homeAirport: seesContact ? row.person.homeAirport : undefined,
        airportPrefs: seesContact ? row.person.airportPrefs : undefined,
      },
      flights: flights?.map((f) => filterRecord(flightRecord(f), FLIGHT_FIELDS, ctx.grants)),
      cars: cars?.map((c) => filterRecord(rentalCarRecord(c), RENTAL_CAR_FIELDS, ctx.grants)),
      housing,
      preferences: prefs.map((p) => filterRecord(housingPreferenceRecord(p), HOUSING_PREFERENCE_FIELDS, ctx.grants)),
    }
  }),

  addFlight: staffProcedure.input(addFlightInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['travel_logistics'])
    const { engagementId, ...fields } = input
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const e = await engagementOrThrow(tx, engagementId)
        const [row] = await tx
          .insert(flight)
          .values({ engagementId, ...flightColumns(fields) })
          .returning({ id: flight.id })
        await auditChange(tx, ctx.user, {
          action: 'create',
          recordType: 'flight',
          recordId: row!.id,
          personId: e.personId,
          keys: FLIGHT_FORM_KEYS,
          fields: FLIGHT_FIELDS,
          detail: { engagementId },
        })
        return { id: row!.id }
      }),
    )
  }),

  updateFlight: staffProcedure.input(updateFlightInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['travel_logistics'])
    const { id, ...fields } = input
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [before] = await tx
          .select({ flight, personId: engagement.personId })
          .from(flight)
          .innerJoin(engagement, eq(engagement.id, flight.engagementId))
          .where(eq(flight.id, id))
          .limit(1)
        if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'That flight no longer exists.' })
        const next = flightColumns(fields)
        const rebooked =
          next.airline !== before.flight.airline ||
          next.flightNumber !== before.flight.flightNumber ||
          next.scheduledDeparture.getTime() !== before.flight.scheduledDeparture.getTime() ||
          next.scheduledArrival.getTime() !== before.flight.scheduledArrival.getTime()
        await tx
          .update(flight)
          .set({ ...next, ...(rebooked ? CLEARED_LIVE : {}) })
          .where(eq(flight.id, id))
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'flight',
          recordId: id,
          personId: before.personId,
          keys: FLIGHT_FORM_KEYS,
          fields: FLIGHT_FIELDS,
        })
        return { id }
      }),
    )
  }),

  removeFlight: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['travel_logistics'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [before] = await tx
          .select({ engagementId: flight.engagementId, personId: engagement.personId })
          .from(flight)
          .innerJoin(engagement, eq(engagement.id, flight.engagementId))
          .where(eq(flight.id, input.id))
          .limit(1)
        if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'That flight no longer exists.' })
        await tx.delete(flight).where(eq(flight.id, input.id))
        await auditChange(tx, ctx.user, {
          action: 'delete',
          recordType: 'flight',
          recordId: input.id,
          personId: before.personId,
          keys: [],
          fields: FLIGHT_FIELDS,
          detail: { engagementId: before.engagementId },
        })
        return { id: input.id }
      }),
    )
  }),

  addCar: staffProcedure.input(addRentalCarInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['travel_logistics'])
    const { engagementId, ...fields } = input
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const e = await engagementOrThrow(tx, engagementId)
        const [row] = await tx
          .insert(rentalCar)
          .values({ engagementId, ...carColumns(fields) })
          .returning({ id: rentalCar.id })
        await auditChange(tx, ctx.user, {
          action: 'create',
          recordType: 'rental_car',
          recordId: row!.id,
          personId: e.personId,
          keys: CAR_FORM_KEYS,
          fields: RENTAL_CAR_FIELDS,
          detail: { engagementId },
        })
        return { id: row!.id }
      }),
    )
  }),

  updateCar: staffProcedure.input(updateRentalCarInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['travel_logistics'])
    const { id, ...fields } = input
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [before] = await tx
          .select({ personId: engagement.personId })
          .from(rentalCar)
          .innerJoin(engagement, eq(engagement.id, rentalCar.engagementId))
          .where(eq(rentalCar.id, id))
          .limit(1)
        if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'That rental car no longer exists.' })
        await tx.update(rentalCar).set(carColumns(fields)).where(eq(rentalCar.id, id))
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'rental_car',
          recordId: id,
          personId: before.personId,
          keys: CAR_FORM_KEYS,
          fields: RENTAL_CAR_FIELDS,
        })
        return { id }
      }),
    )
  }),

  removeCar: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['travel_logistics'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [before] = await tx
          .select({ engagementId: rentalCar.engagementId, personId: engagement.personId })
          .from(rentalCar)
          .innerJoin(engagement, eq(engagement.id, rentalCar.engagementId))
          .where(eq(rentalCar.id, input.id))
          .limit(1)
        if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'That rental car no longer exists.' })
        await tx.delete(rentalCar).where(eq(rentalCar.id, input.id))
        await auditChange(tx, ctx.user, {
          action: 'delete',
          recordType: 'rental_car',
          recordId: input.id,
          personId: before.personId,
          keys: [],
          fields: RENTAL_CAR_FIELDS,
          detail: { engagementId: before.engagementId },
        })
        return { id: input.id }
      }),
    )
  }),
})
