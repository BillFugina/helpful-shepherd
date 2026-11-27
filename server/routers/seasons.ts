import { TRPCError } from '@trpc/server'
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { filterRecord, levelAtLeast, levelFor } from '../../shared/access.js'
import {
  CONFLICT_FIELDS,
  createProductionInput,
  createSeasonInput,
  ENGAGEMENT_FIELDS,
  PRODUCTION_FIELDS,
  SEASON_FIELDS,
  updateProductionInput,
  updateSeasonInput,
} from '../../shared/roster.js'
import type { Db } from '../db/client.js'
import { agent, conflict, engagement, person, production, season } from '../db/schema.js'
import { conflictRecord, engagementRecord, productionRecord, seasonRecord } from '../roster/records.js'
import { router, staffProcedure } from '../trpc.js'
import { auditChange, friendly, groupsOf, requireEdit, requireView, writtenKeys } from '../writes.js'
import { paperworkChanged } from '../reminders/announce.js'

async function seasonOrThrow(db: Db, id: string) {
  const [row] = await db.select().from(season).where(eq(season.id, id)).limit(1)
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That season no longer exists.' })
  return row
}

export const seasonsRouter = router({
  list: staffProcedure.query(async ({ ctx }) => {
    requireView(ctx.grants, 'general')
    const rows = await ctx.db.select().from(season).orderBy(desc(season.startsOn))
    const counts = await ctx.db
      .select({
        seasonId: production.seasonId,
        productions: count(sql`distinct ${production.id}`),
        people: count(engagement.id),
      })
      .from(production)
      .leftJoin(engagement, eq(engagement.productionId, production.id))
      .groupBy(production.seasonId)
    const bySeason = new Map(counts.map((c) => [c.seasonId, c]))
    return rows.map((row) => ({
      ...filterRecord(seasonRecord(row), SEASON_FIELDS, ctx.grants),
      productionCount: bySeason.get(row.id)?.productions ?? 0,
      engagementCount: bySeason.get(row.id)?.people ?? 0,
    }))
  }),

  create: staffProcedure.input(createSeasonInput).mutation(async ({ ctx, input }) => {
    const keys = writtenKeys(input, SEASON_FIELDS)
    requireEdit(ctx.grants, groupsOf(keys, SEASON_FIELDS))
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx.insert(season).values(input).returning({ id: season.id })
        await auditChange(tx, ctx.user, {
          action: 'create',
          recordType: 'season',
          recordId: row!.id,
          keys,
          fields: SEASON_FIELDS,
        })
        return { id: row!.id }
      }),
    )
  }),

  update: staffProcedure.input(updateSeasonInput).mutation(async ({ ctx, input }) => {
    const { id, ...changes } = input
    const keys = writtenKeys(changes, SEASON_FIELDS)
    requireEdit(ctx.grants, groupsOf(keys, SEASON_FIELDS))
    if (!keys.length) return { id }
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        await seasonOrThrow(tx, id)
        await tx.update(season).set(changes).where(eq(season.id, id))
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'season',
          recordId: id,
          keys,
          fields: SEASON_FIELDS,
        })
        return { id }
      }),
    )
  }),

  /**
   * The season at a glance: every production with its people, their role and
   * where they are in the pipeline. Fields the role can't see are left out.
   */
  dashboard: staffProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'general')
    const s = await seasonOrThrow(ctx.db, input.id)
    const productions = await ctx.db
      .select()
      .from(production)
      .where(eq(production.seasonId, s.id))
      .orderBy(sql`${production.rehearsalStart} asc nulls last`, asc(production.title))
    const productionIds = productions.map((p) => p.id)
    const rows = productionIds.length
      ? await ctx.db
          .select({
            engagement,
            legalName: person.legalName,
            preferredName: person.preferredName,
            agentName: agent.name,
          })
          .from(engagement)
          .innerJoin(person, eq(person.id, engagement.personId))
          .leftJoin(agent, eq(agent.id, engagement.agentId))
          .where(inArray(engagement.productionId, productionIds))
          .orderBy(asc(person.legalName))
      : []
    const engagementIds = rows.map((r) => r.engagement.id)
    const conflictCounts = engagementIds.length
      ? await ctx.db
          .select({ engagementId: conflict.engagementId, n: count() })
          .from(conflict)
          .where(inArray(conflict.engagementId, engagementIds))
          .groupBy(conflict.engagementId)
      : []
    const conflictsBy = new Map(conflictCounts.map((c) => [c.engagementId, c.n]))
    const seesContact = levelAtLeast(levelFor(ctx.grants, 'contact'), 'view')

    return {
      season: filterRecord(seasonRecord(s), SEASON_FIELDS, ctx.grants),
      productions: productions.map((p) => ({
        ...filterRecord(productionRecord(p), PRODUCTION_FIELDS, ctx.grants),
        engagements: rows
          .filter((r) => r.engagement.productionId === p.id)
          .map((r) => ({
            ...filterRecord(engagementRecord(r.engagement), ENGAGEMENT_FIELDS, ctx.grants),
            // The person's name is General; the agent's name is Contact.
            person: { id: r.engagement.personId, legalName: r.legalName, preferredName: r.preferredName },
            agentName: seesContact ? r.agentName : undefined,
            conflictCount: conflictsBy.get(r.engagement.id) ?? 0,
          })),
      })),
    }
  }),
})

export const productionsRouter = router({
  /** Every production, newest season first, with its season's name. */
  list: staffProcedure.query(async ({ ctx }) => {
    requireView(ctx.grants, 'general')
    const rows = await ctx.db
      .select({ production, seasonName: season.name, seasonStartsOn: season.startsOn })
      .from(production)
      .innerJoin(season, eq(season.id, production.seasonId))
      .orderBy(desc(season.startsOn), sql`${production.rehearsalStart} asc nulls last`, asc(production.title))
    return rows.map((r) => ({
      ...filterRecord(productionRecord(r.production), PRODUCTION_FIELDS, ctx.grants),
      seasonName: r.seasonName,
    }))
  }),

  /**
   * Everyone's conflicts on one production, soonest first. With `from`, only
   * conflicts that haven't ended before that date.
   */
  conflicts: staffProcedure
    .input(z.object({ id: z.uuid(), from: z.iso.date().optional() }))
    .query(async ({ ctx, input }) => {
      requireView(ctx.grants, 'general')
      const rows = await ctx.db
        .select({
          conflict,
          role: engagement.role,
          personId: person.id,
          legalName: person.legalName,
          preferredName: person.preferredName,
        })
        .from(conflict)
        .innerJoin(engagement, eq(engagement.id, conflict.engagementId))
        .innerJoin(person, eq(person.id, engagement.personId))
        .where(and(eq(engagement.productionId, input.id), input.from ? gte(conflict.endsOn, input.from) : undefined))
        .orderBy(asc(conflict.startsOn), asc(person.legalName))
      return rows.map((r) => ({
        ...filterRecord(conflictRecord(r.conflict), CONFLICT_FIELDS, ctx.grants),
        role: r.role,
        person: { id: r.personId, legalName: r.legalName, preferredName: r.preferredName },
      }))
    }),

  get: staffProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'general')
    const [row] = await ctx.db
      .select({ production, seasonName: season.name })
      .from(production)
      .innerJoin(season, eq(season.id, production.seasonId))
      .where(eq(production.id, input.id))
      .limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That production no longer exists.' })
    return {
      ...filterRecord(productionRecord(row.production), PRODUCTION_FIELDS, ctx.grants),
      seasonName: row.seasonName,
    }
  }),

  create: staffProcedure.input(createProductionInput).mutation(async ({ ctx, input }) => {
    const keys = writtenKeys(input, PRODUCTION_FIELDS)
    requireEdit(ctx.grants, groupsOf(keys, PRODUCTION_FIELDS))
    const created = await friendly(() =>
      ctx.db.transaction(async (tx) => {
        await seasonOrThrow(tx, input.seasonId)
        const [row] = await tx.insert(production).values(input).returning({ id: production.id })
        await auditChange(tx, ctx.user, {
          action: 'create',
          recordType: 'production',
          recordId: row!.id,
          keys,
          fields: PRODUCTION_FIELDS,
          detail: { seasonId: input.seasonId },
        })
        return { id: row!.id }
      }),
    )
    if (input.rehearsalStart) await paperworkChanged([created.id])
    return created
  }),

  update: staffProcedure.input(updateProductionInput).mutation(async ({ ctx, input }) => {
    const { id, ...changes } = input
    const keys = writtenKeys(changes, PRODUCTION_FIELDS)
    requireEdit(ctx.grants, groupsOf(keys, PRODUCTION_FIELDS))
    if (!keys.length) return { id }
    const saved = await friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(production)
          .set(changes)
          .where(eq(production.id, id))
          .returning({ id: production.id })
        if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'That production no longer exists.' })
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'production',
          recordId: id,
          keys,
          fields: PRODUCTION_FIELDS,
        })
        return { id }
      }),
    )
    // A new first-rehearsal date moves the paperwork reminder.
    if ('rehearsalStart' in changes) await paperworkChanged([id])
    return saved
  }),
})
