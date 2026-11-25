import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { filterRecord, levelAtLeast, levelFor, PERSON_FIELDS } from '../../shared/access.js'
import { ENGAGEMENT_FIELDS, personFields, updatePersonInput } from '../../shared/roster.js'
import { revealPersonFieldInput } from '../../shared/schemas.js'
import { recordAudit } from '../audit.js'
import { decryptField, fieldKey } from '../crypto/fields.js'
import { agent, engagement, person, production, season } from '../db/schema.js'
import { personColumns, PERSON_STORAGE, toPersonRecord } from '../registry/person.js'
import { createPerson } from '../roster/create.js'
import { engagementRecord } from '../roster/records.js'
import { router, staffProcedure } from '../trpc.js'
import { auditChange, friendly, groupsOf, requireEdit, requireView, writtenKeys } from '../writes.js'

/** Escapes LIKE wildcards so a search for "50%" means the text, not a pattern. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

export const peopleRouter = router({
  list: staffProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(person).orderBy(asc(person.legalName))
    return rows.map((row) => filterRecord(toPersonRecord(row), PERSON_FIELDS, ctx.grants))
  }),

  /** One person's profile and every production they've been on, newest season first. */
  get: staffProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db.select().from(person).where(eq(person.id, input.id)).limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That person no longer exists.' })
    const seesGeneral = levelAtLeast(levelFor(ctx.grants, 'general'), 'view')
    const seesContact = levelAtLeast(levelFor(ctx.grants, 'contact'), 'view')
    const history = seesGeneral
      ? await ctx.db
          .select({
            engagement,
            productionTitle: production.title,
            seasonId: season.id,
            seasonName: season.name,
            agentName: agent.name,
            agentAgency: agent.agency,
          })
          .from(engagement)
          .innerJoin(production, eq(production.id, engagement.productionId))
          .innerJoin(season, eq(season.id, production.seasonId))
          .leftJoin(agent, eq(agent.id, engagement.agentId))
          .where(eq(engagement.personId, row.id))
          .orderBy(desc(season.startsOn), sql`${production.rehearsalStart} desc nulls last`)
      : []
    const latestWithAgent = history.find((h) => h.engagement.agentId)
    return {
      person: filterRecord(toPersonRecord(row), PERSON_FIELDS, ctx.grants),
      engagements: history.map((h) => ({
        ...filterRecord(engagementRecord(h.engagement), ENGAGEMENT_FIELDS, ctx.grants),
        productionTitle: h.productionTitle,
        seasonId: h.seasonId,
        seasonName: h.seasonName,
        agentName: seesContact ? h.agentName : undefined,
      })),
      /** For prefilling a new engagement: the agent on their most recent deal. */
      latestAgent:
        seesContact && latestWithAgent?.engagement.agentId
          ? {
              id: latestWithAgent.engagement.agentId,
              name: latestWithAgent.agentName,
              agency: latestWithAgent.agentAgency,
            }
          : null,
    }
  }),

  /** Find a returning person by name (or email, for roles that can see email). */
  search: staffProcedure.input(z.object({ q: z.string().trim().min(1).max(100) })).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'general')
    const seesContact = levelAtLeast(levelFor(ctx.grants, 'contact'), 'view')
    const pattern = likePattern(input.q)
    const match = or(
      ilike(person.legalName, pattern),
      ilike(person.preferredName, pattern),
      seesContact ? ilike(person.email, pattern) : undefined,
    )
    const rows = await ctx.db.select().from(person).where(match).orderBy(asc(person.legalName)).limit(10)
    return rows.map((r) => ({
      id: r.id,
      legalName: r.legalName,
      preferredName: r.preferredName,
      email: seesContact ? r.email : undefined,
      homeAirport: seesContact ? r.homeAirport : undefined,
    }))
  }),

  create: staffProcedure.input(personFields).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, groupsOf(writtenKeys(input, PERSON_FIELDS), PERSON_FIELDS))
    const id = await friendly(() => ctx.db.transaction((tx) => createPerson(tx, ctx.user, input, 'form')))
    return { id }
  }),

  /** Masked fields are write-only here: send a value to set it, null to clear it, or leave it out. */
  update: staffProcedure.input(updatePersonInput).mutation(async ({ ctx, input }) => {
    const { id, ...changes } = input
    const keys = writtenKeys(changes, PERSON_FIELDS)
    requireEdit(ctx.grants, groupsOf(keys, PERSON_FIELDS))
    if (!keys.length) return { id }
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        if (changes.email) {
          const [dupe] = await tx
            .select({ id: person.id })
            .from(person)
            .where(and(eq(sql`lower(${person.email})`, changes.email.toLowerCase()), sql`${person.id} <> ${id}`))
            .limit(1)
          if (dupe)
            throw new TRPCError({ code: 'CONFLICT', message: 'Someone else in the app already has this email.' })
        }
        const [row] = await tx
          .update(person)
          .set(personColumns(changes))
          .where(eq(person.id, id))
          .returning({ id: person.id })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That person no longer exists.' })
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'person',
          recordId: id,
          personId: id,
          keys,
          fields: PERSON_FIELDS,
        })
        return { id }
      }),
    )
  }),

  /** The only way a masked value leaves the server. Checks the grant and logs the view. */
  reveal: staffProcedure.input(revealPersonFieldInput).mutation(async ({ ctx, input }) => {
    const group = PERSON_FIELDS[input.field]
    if (!levelAtLeast(levelFor(ctx.grants, group), 'view')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Your role has no access to this field.' })
    }
    const { column, aad } = PERSON_STORAGE[input.field]
    const [row] = await ctx.db.select().from(person).where(eq(person.id, input.personId)).limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND' })

    await recordAudit(ctx.db, {
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'reveal',
      recordType: 'person',
      recordId: row.id,
      personId: row.id,
      fieldGroup: group,
      detail: { field: input.field },
    })

    const stored = row[column]
    return { value: stored ? decryptField(stored, aad, fieldKey()) : null }
  }),
})
