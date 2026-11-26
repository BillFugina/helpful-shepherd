import { TRPCError } from '@trpc/server'
import { and, asc, eq, gt, lt, ne } from 'drizzle-orm'
import { z } from 'zod'
import { filterRecord } from '../../shared/access.js'
import { addDays } from '../../shared/time.js'
import {
  addHousingRoomInput,
  assignHousingInput,
  HOUSING_ASSIGNMENT_FIELDS,
  HOUSING_PREFERENCE_FIELDS,
  HOUSING_ROOM_FIELDS,
  HOUSING_UNIT_FIELDS,
  housingUnitFields,
  occupancyInput,
  setPreferenceInput,
  updateAssignmentInput,
  updateHousingRoomInput,
  updateHousingUnitInput,
} from '../../shared/travel.js'
import type { Db } from '../db/client.js'
import { engagement, housingAssignment, housingPreference, housingRoom, housingUnit, person } from '../db/schema.js'
import { staysInWindow } from '../travel/housing.js'
import { housingRoomRecord, housingUnitRecord, shortName } from '../travel/records.js'
import { router, staffProcedure } from '../trpc.js'
import { auditChange, friendly, requireEdit, requireView, writtenKeys } from '../writes.js'
import { engagementOrThrow } from './travel.js'

const formatNight = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * Refuses a stay that shares a night with another stay in the same room, or
 * with another stay of the same person. The room row is locked first, so two
 * people assigning the same room at once can't both win.
 */
async function checkStayFree(
  db: Db,
  stay: { roomId: string; engagementId: string; startsOn: string; endsOn: string },
  ignoreId?: string,
): Promise<void> {
  const [room] = await db.select().from(housingRoom).where(eq(housingRoom.id, stay.roomId)).for('update').limit(1)
  if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'That room no longer exists.' })
  const overlapping = and(lt(housingAssignment.startsOn, stay.endsOn), gt(housingAssignment.endsOn, stay.startsOn))
  const notSelf = ignoreId ? ne(housingAssignment.id, ignoreId) : undefined
  const [taken] = await db
    .select({ a: housingAssignment, legalName: person.legalName, preferredName: person.preferredName })
    .from(housingAssignment)
    .innerJoin(engagement, eq(engagement.id, housingAssignment.engagementId))
    .innerJoin(person, eq(person.id, engagement.personId))
    .where(and(eq(housingAssignment.roomId, stay.roomId), overlapping, notSelf))
    .limit(1)
  if (taken) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `${room.name} is taken by ${shortName(taken)} from ${formatNight(taken.a.startsOn)} to ${formatNight(taken.a.endsOn)}.`,
    })
  }
  const [twice] = await db
    .select({ id: housingAssignment.id })
    .from(housingAssignment)
    .where(and(eq(housingAssignment.engagementId, stay.engagementId), overlapping, notSelf))
    .limit(1)
  if (twice) {
    throw new TRPCError({ code: 'CONFLICT', message: 'This person already has a room for some of those nights.' })
  }
}

export const housingRouter = router({
  /** Every place and its rooms. */
  units: staffProcedure.query(async ({ ctx }) => {
    requireView(ctx.grants, 'housing_access')
    const units = await ctx.db.select().from(housingUnit).orderBy(asc(housingUnit.name))
    const rooms = await ctx.db.select().from(housingRoom).orderBy(asc(housingRoom.floor), asc(housingRoom.name))
    return units.map((u) => ({
      ...filterRecord(housingUnitRecord(u), HOUSING_UNIT_FIELDS, ctx.grants),
      rooms: rooms
        .filter((r) => r.unitId === u.id)
        .map((r) => filterRecord(housingRoomRecord(r), HOUSING_ROOM_FIELDS, ctx.grants)),
    }))
  }),

  createUnit: staffProcedure.input(housingUnitFields).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['housing_access'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx.insert(housingUnit).values(input).returning({ id: housingUnit.id })
        await auditChange(tx, ctx.user, {
          action: 'create',
          recordType: 'housing_unit',
          recordId: row!.id,
          keys: writtenKeys(input, HOUSING_UNIT_FIELDS),
          fields: HOUSING_UNIT_FIELDS,
        })
        return { id: row!.id }
      }),
    )
  }),

  updateUnit: staffProcedure.input(updateHousingUnitInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['housing_access'])
    const { id, ...changes } = input
    const keys = writtenKeys(changes, HOUSING_UNIT_FIELDS)
    if (!keys.length) return { id }
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .update(housingUnit)
          .set(changes)
          .where(eq(housingUnit.id, id))
          .returning({ id: housingUnit.id })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That place no longer exists.' })
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'housing_unit',
          recordId: id,
          keys,
          fields: HOUSING_UNIT_FIELDS,
        })
        return { id }
      }),
    )
  }),

  /** Deletes a place and its rooms. Refused while anyone is assigned to one of them. */
  removeUnit: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['housing_access'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx.delete(housingUnit).where(eq(housingUnit.id, input.id)).returning({ id: housingUnit.id })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That place no longer exists.' })
        await auditChange(tx, ctx.user, {
          action: 'delete',
          recordType: 'housing_unit',
          recordId: input.id,
          keys: [],
          fields: HOUSING_UNIT_FIELDS,
        })
        return { id: input.id }
      }),
    )
  }),

  addRoom: staffProcedure.input(addHousingRoomInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['housing_access'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx.insert(housingRoom).values(input).returning({ id: housingRoom.id })
        await auditChange(tx, ctx.user, {
          action: 'create',
          recordType: 'housing_room',
          recordId: row!.id,
          keys: writtenKeys(input, HOUSING_ROOM_FIELDS),
          fields: HOUSING_ROOM_FIELDS,
          detail: { unitId: input.unitId },
        })
        return { id: row!.id }
      }),
    )
  }),

  updateRoom: staffProcedure.input(updateHousingRoomInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['housing_access'])
    const { id, ...changes } = input
    const keys = writtenKeys(changes, HOUSING_ROOM_FIELDS)
    if (!keys.length) return { id }
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .update(housingRoom)
          .set(changes)
          .where(eq(housingRoom.id, id))
          .returning({ id: housingRoom.id })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That room no longer exists.' })
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'housing_room',
          recordId: id,
          keys,
          fields: HOUSING_ROOM_FIELDS,
        })
        return { id }
      }),
    )
  }),

  removeRoom: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['housing_access'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx.delete(housingRoom).where(eq(housingRoom.id, input.id)).returning({ id: housingRoom.id })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That room no longer exists.' })
        await auditChange(tx, ctx.user, {
          action: 'delete',
          recordType: 'housing_room',
          recordId: input.id,
          keys: [],
          fields: HOUSING_ROOM_FIELDS,
        })
        return { id: input.id }
      }),
    )
  }),

  /** The occupancy calendar: who is in each room each night of a window, with warnings. */
  occupancy: staffProcedure.input(occupancyInput).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'housing_access')
    const to = addDays(input.from, input.days)
    const { stays, warnings } = await staysInWindow(ctx.db, input.from, to)
    // Where to look next when this window is empty.
    const [next] = await ctx.db
      .select({ startsOn: housingAssignment.startsOn })
      .from(housingAssignment)
      .where(gt(housingAssignment.endsOn, input.from))
      .orderBy(asc(housingAssignment.startsOn))
      .limit(1)
    return {
      nextStayFrom: next?.startsOn ?? null,
      from: input.from,
      days: input.days,
      stays: stays.map((s) => ({
        assignmentId: s.assignmentId,
        engagementId: s.engagementId,
        personName: s.personName,
        roomId: s.roomId,
        startsOn: s.startsOn,
        endsOn: s.endsOn,
      })),
      warnings,
    }
  }),

  assign: staffProcedure.input(assignHousingInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['housing_access'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const e = await engagementOrThrow(tx, input.engagementId)
        await checkStayFree(tx, input)
        const [row] = await tx.insert(housingAssignment).values(input).returning({ id: housingAssignment.id })
        await auditChange(tx, ctx.user, {
          action: 'create',
          recordType: 'housing_assignment',
          recordId: row!.id,
          personId: e.personId,
          keys: ['startsOn', 'endsOn'],
          fields: HOUSING_ASSIGNMENT_FIELDS,
          detail: { engagementId: input.engagementId, roomId: input.roomId },
        })
        return { id: row!.id }
      }),
    )
  }),

  updateAssignment: staffProcedure.input(updateAssignmentInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['housing_access'])
    const { id, ...changes } = input
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [before] = await tx
          .select({ a: housingAssignment, personId: engagement.personId })
          .from(housingAssignment)
          .innerJoin(engagement, eq(engagement.id, housingAssignment.engagementId))
          .where(eq(housingAssignment.id, id))
          .limit(1)
        if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'That stay no longer exists.' })
        const next = {
          roomId: changes.roomId ?? before.a.roomId,
          startsOn: changes.startsOn ?? before.a.startsOn,
          endsOn: changes.endsOn ?? before.a.endsOn,
        }
        if (next.startsOn >= next.endsOn) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Move-out must be after move-in.' })
        }
        await checkStayFree(tx, { ...next, engagementId: before.a.engagementId }, id)
        await tx.update(housingAssignment).set(next).where(eq(housingAssignment.id, id))
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'housing_assignment',
          recordId: id,
          personId: before.personId,
          keys: ['startsOn', 'endsOn'],
          fields: HOUSING_ASSIGNMENT_FIELDS,
          detail: changes.roomId && changes.roomId !== before.a.roomId ? { roomId: changes.roomId } : undefined,
        })
        return { id }
      }),
    )
  }),

  removeAssignment: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['housing_access'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [before] = await tx
          .select({ engagementId: housingAssignment.engagementId, personId: engagement.personId })
          .from(housingAssignment)
          .innerJoin(engagement, eq(engagement.id, housingAssignment.engagementId))
          .where(eq(housingAssignment.id, input.id))
          .limit(1)
        if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'That stay no longer exists.' })
        await tx.delete(housingAssignment).where(eq(housingAssignment.id, input.id))
        await auditChange(tx, ctx.user, {
          action: 'delete',
          recordType: 'housing_assignment',
          recordId: input.id,
          personId: before.personId,
          keys: [],
          fields: HOUSING_ASSIGNMENT_FIELDS,
          detail: { engagementId: before.engagementId },
        })
        return { id: input.id }
      }),
    )
  }),

  /** Adds a housing rule for a person, or updates its note. */
  setPreference: staffProcedure.input(setPreferenceInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['general'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [p] = await tx.select({ id: person.id }).from(person).where(eq(person.id, input.personId)).limit(1)
        if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: 'That person no longer exists.' })
        const [row] = await tx
          .insert(housingPreference)
          .values({ personId: input.personId, rule: input.rule, note: input.note ?? null })
          .onConflictDoUpdate({
            target: [housingPreference.personId, housingPreference.rule],
            set: { note: input.note ?? null },
          })
          .returning({ id: housingPreference.id })
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'housing_preference',
          recordId: row!.id,
          personId: input.personId,
          keys: ['rule', 'note'],
          fields: HOUSING_PREFERENCE_FIELDS,
        })
        return { id: row!.id }
      }),
    )
  }),

  removePreference: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['general'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .delete(housingPreference)
          .where(eq(housingPreference.id, input.id))
          .returning({ personId: housingPreference.personId })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That housing rule no longer exists.' })
        await auditChange(tx, ctx.user, {
          action: 'delete',
          recordType: 'housing_preference',
          recordId: input.id,
          personId: row.personId,
          keys: [],
          fields: HOUSING_PREFERENCE_FIELDS,
        })
        return { id: input.id }
      }),
    )
  }),
})
