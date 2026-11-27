import { TRPCError } from '@trpc/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { filterRecord, levelAtLeast, levelFor, PERSON_FIELDS, type FieldGroup } from '../../shared/access.js'
import {
  addConflictInput,
  AGENT_FIELDS,
  CONFLICT_FIELDS,
  ENGAGEMENT_FIELDS,
  quickCreateEngagementInput,
  setPipelineStatusInput,
  updateEngagementInput,
} from '../../shared/roster.js'
import type { Db } from '../db/client.js'
import { agent, conflict, engagement, person, production, season } from '../db/schema.js'
import { toPersonRecord } from '../registry/person.js'
import { decideDraft } from '../connector/drafts.js'
import { addConflict, createAgent, createEngagement, createPerson, requireProduction } from '../roster/create.js'
import { agentRecord, conflictRecord, engagementRecord } from '../roster/records.js'
import { router, staffProcedure } from '../trpc.js'
import { auditChange, friendly, groupsOf, requireEdit, requireView, writtenKeys } from '../writes.js'
import { paperworkChanged } from '../reminders/announce.js'

async function engagementOrThrow(db: Db, id: string) {
  const [row] = await db.select().from(engagement).where(eq(engagement.id, id)).limit(1)
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That engagement no longer exists.' })
  return row
}

export const engagementsRouter = router({
  get: staffProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'general')
    const [row] = await ctx.db
      .select({ engagement, person, production, seasonName: season.name, agent })
      .from(engagement)
      .innerJoin(person, eq(person.id, engagement.personId))
      .innerJoin(production, eq(production.id, engagement.productionId))
      .innerJoin(season, eq(season.id, production.seasonId))
      .leftJoin(agent, eq(agent.id, engagement.agentId))
      .where(eq(engagement.id, input.id))
      .limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That engagement no longer exists.' })
    const conflicts = await ctx.db
      .select()
      .from(conflict)
      .where(eq(conflict.engagementId, row.engagement.id))
      .orderBy(asc(conflict.startsOn))
    // Who they are and how to reach them, after the role's filter. A field the
    // role can't see comes through as undefined.
    const visiblePerson = filterRecord(toPersonRecord(row.person), PERSON_FIELDS, ctx.grants)
    const personSummary = {
      id: visiblePerson.id,
      legalName: visiblePerson.legalName,
      preferredName: visiblePerson.preferredName,
      email: visiblePerson.email,
      cell: visiblePerson.cell,
      homeAirport: visiblePerson.homeAirport,
    }
    const seesContact = levelAtLeast(levelFor(ctx.grants, 'contact'), 'view')
    return {
      engagement: filterRecord(engagementRecord(row.engagement), ENGAGEMENT_FIELDS, ctx.grants),
      person: personSummary,
      production: { id: row.production.id, title: row.production.title, seasonId: row.production.seasonId },
      seasonName: row.seasonName,
      agent: seesContact && row.agent ? filterRecord(agentRecord(row.agent), AGENT_FIELDS, ctx.grants) : null,
      conflicts: conflicts.map((c) => filterRecord(conflictRecord(c), CONFLICT_FIELDS, ctx.grants)),
    }
  }),

  /**
   * The fast-entry form. A returning or new person, their agent, the terms and
   * any conflicts, saved in one transaction: all of it lands, or none does.
   */
  quickCreate: staffProcedure.input(quickCreateEngagementInput).mutation(async ({ ctx, input }) => {
    const groups = new Set<FieldGroup>(groupsOf(writtenKeys(input.terms, ENGAGEMENT_FIELDS), ENGAGEMENT_FIELDS))
    groups.add('general')
    if (input.person.kind === 'new') {
      for (const g of groupsOf(writtenKeys(input.person.person, PERSON_FIELDS), PERSON_FIELDS)) groups.add(g)
    }
    if (input.agent.kind !== 'none') groups.add('contact')
    requireEdit(ctx.grants, [...groups])

    const saved = await friendly(() =>
      ctx.db.transaction(async (tx) => {
        await requireProduction(tx, input.productionId)
        let personId: string
        if (input.person.kind === 'existing') {
          const [p] = await tx
            .select({ id: person.id })
            .from(person)
            .where(eq(person.id, input.person.personId))
            .limit(1)
          if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: 'That person no longer exists.' })
          personId = p.id
        } else {
          personId = await createPerson(tx, ctx.user, input.person.person, 'fast_entry')
        }
        let agentId: string | null = null
        if (input.agent.kind === 'existing') {
          const [a] = await tx.select({ id: agent.id }).from(agent).where(eq(agent.id, input.agent.agentId)).limit(1)
          if (!a) throw new TRPCError({ code: 'NOT_FOUND', message: 'That agent no longer exists.' })
          agentId = a.id
        } else if (input.agent.kind === 'new') {
          agentId = await createAgent(tx, ctx.user, input.agent.agent, 'fast_entry')
        }
        const id = await createEngagement(
          tx,
          ctx.user,
          { productionId: input.productionId, personId, agentId, terms: input.terms, conflicts: input.conflicts },
          'fast_entry',
        )
        // Saved from a connector draft: close the draft in the same transaction.
        if (input.draftId) {
          await decideDraft(tx, ctx.user, input.draftId, {
            status: 'accepted',
            engagementId: id,
            personId,
            productionId: input.productionId,
          })
        }
        return { id, personId }
      }),
    )
    // Someone added late still gets the paperwork reminder.
    await paperworkChanged([input.productionId])
    return saved
  }),

  update: staffProcedure.input(updateEngagementInput).mutation(async ({ ctx, input }) => {
    const { id, ...changes } = input
    const keys = writtenKeys(changes, ENGAGEMENT_FIELDS)
    requireEdit(ctx.grants, groupsOf(keys, ENGAGEMENT_FIELDS))
    if (!keys.length) return { id }
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const before = await engagementOrThrow(tx, id)
        const from = before.pipelineStatus
        await tx.update(engagement).set(changes).where(eq(engagement.id, id))
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'engagement',
          recordId: id,
          personId: before.personId,
          keys,
          fields: ENGAGEMENT_FIELDS,
          detail:
            changes.pipelineStatus && changes.pipelineStatus !== from
              ? { from, to: changes.pipelineStatus }
              : undefined,
        })
        return { id }
      }),
    )
  }),

  /** Moves a person along the pipeline (or back, to fix a mistake). */
  setStatus: staffProcedure.input(setPipelineStatusInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['general'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        // Lock the row so two quick taps log a true from -> to chain.
        const [before] = await tx.select().from(engagement).where(eq(engagement.id, input.id)).for('update').limit(1)
        if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'That engagement no longer exists.' })
        if (before.pipelineStatus === input.status) return { changed: false }
        await tx.update(engagement).set({ pipelineStatus: input.status }).where(eq(engagement.id, input.id))
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'engagement',
          recordId: input.id,
          personId: before.personId,
          keys: ['pipelineStatus'],
          fields: ENGAGEMENT_FIELDS,
          detail: { from: before.pipelineStatus, to: input.status },
        })
        return { changed: true }
      }),
    )
  }),

  /** Takes a person off a production. Their profile and other engagements stay. */
  remove: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    // Removing a deal removes its terms, so it needs edit on every group the deal holds.
    requireEdit(ctx.grants, ['general', 'contact', 'pay_terms'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const before = await engagementOrThrow(tx, input.id)
        await tx.delete(engagement).where(eq(engagement.id, input.id))
        await auditChange(tx, ctx.user, {
          action: 'delete',
          recordType: 'engagement',
          recordId: input.id,
          personId: before.personId,
          keys: [],
          fields: ENGAGEMENT_FIELDS,
          detail: { productionId: before.productionId },
        })
        return { id: input.id }
      }),
    )
  }),

  addConflict: staffProcedure.input(addConflictInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['general'])
    const { engagementId, ...fields } = input
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const e = await engagementOrThrow(tx, engagementId)
        const id = await addConflict(tx, ctx.user, engagementId, e.personId, fields)
        return { id }
      }),
    )
  }),

  removeConflict: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['general'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ conflict, personId: engagement.personId })
          .from(conflict)
          .innerJoin(engagement, eq(engagement.id, conflict.engagementId))
          .where(eq(conflict.id, input.id))
          .limit(1)
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That conflict no longer exists.' })
        await tx.delete(conflict).where(eq(conflict.id, input.id))
        await auditChange(tx, ctx.user, {
          action: 'delete',
          recordType: 'conflict',
          recordId: input.id,
          personId: row.personId,
          keys: [],
          fields: CONFLICT_FIELDS,
          detail: { engagementId: row.conflict.engagementId },
        })
        return { id: input.id }
      }),
    )
  }),
})
