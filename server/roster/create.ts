import { TRPCError } from '@trpc/server'
import { eq, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { PERSON_FIELDS } from '../../shared/access.js'
import {
  AGENT_FIELDS,
  CONFLICT_FIELDS,
  ENGAGEMENT_FIELDS,
  type agentFields,
  type conflictFields,
  type engagementTerms,
  type personFields,
} from '../../shared/roster.js'
import type { Db } from '../db/client.js'
import { agent, conflict, engagement, person, production } from '../db/schema.js'
import { personColumns } from '../registry/person.js'
import type { SessionUser } from '../trpc.js'
import { auditChange, writtenKeys } from '../writes.js'

/** Where a write came from, kept in the audit detail. */
export type Source = 'form' | 'fast_entry' | 'import'

export async function createPerson(
  db: Db,
  user: SessionUser,
  input: z.output<typeof personFields>,
  source: Source,
): Promise<string> {
  if (input.email) {
    const [dupe] = await db
      .select({ id: person.id })
      .from(person)
      .where(eq(sql`lower(${person.email})`, input.email.toLowerCase()))
      .limit(1)
    if (dupe) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Someone with this email is already in the app. Pick them as a returning person instead.',
      })
    }
  }
  const [row] = await db
    .insert(person)
    .values({ legalName: input.legalName, ...personColumns(input) })
    .returning({ id: person.id })
  const id = row!.id
  await auditChange(db, user, {
    action: 'create',
    recordType: 'person',
    recordId: id,
    personId: id,
    keys: writtenKeys(input, PERSON_FIELDS),
    fields: PERSON_FIELDS,
    detail: { source },
  })
  return id
}

export async function createAgent(
  db: Db,
  user: SessionUser,
  input: z.output<typeof agentFields>,
  source: Source,
): Promise<string> {
  const [row] = await db.insert(agent).values(input).returning({ id: agent.id })
  const id = row!.id
  await auditChange(db, user, {
    action: 'create',
    recordType: 'agent',
    recordId: id,
    keys: writtenKeys(input, AGENT_FIELDS),
    fields: AGENT_FIELDS,
    detail: { source },
  })
  return id
}

export async function requireProduction(db: Db, productionId: string): Promise<void> {
  const [row] = await db.select({ id: production.id }).from(production).where(eq(production.id, productionId)).limit(1)
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That production no longer exists.' })
}

export async function createEngagement(
  db: Db,
  user: SessionUser,
  input: {
    productionId: string
    personId: string
    agentId: string | null
    terms: z.output<typeof engagementTerms>
    conflicts: z.output<typeof conflictFields>[]
  },
  source: Source,
): Promise<string> {
  const values = { ...input.terms, productionId: input.productionId, personId: input.personId, agentId: input.agentId }
  const [row] = await db.insert(engagement).values(values).returning({ id: engagement.id })
  const id = row!.id
  const keys = writtenKeys(values, ENGAGEMENT_FIELDS)
  await auditChange(db, user, {
    action: 'create',
    recordType: 'engagement',
    recordId: id,
    personId: input.personId,
    keys,
    fields: ENGAGEMENT_FIELDS,
    detail: { source, productionId: input.productionId },
  })
  for (const c of input.conflicts) await addConflict(db, user, id, input.personId, c)
  return id
}

export async function addConflict(
  db: Db,
  user: SessionUser,
  engagementId: string,
  personId: string,
  input: z.output<typeof conflictFields>,
): Promise<string> {
  const [row] = await db
    .insert(conflict)
    .values({ ...input, engagementId })
    .returning({ id: conflict.id })
  await auditChange(db, user, {
    action: 'create',
    recordType: 'conflict',
    recordId: row!.id,
    personId,
    keys: writtenKeys(input, CONFLICT_FIELDS),
    fields: CONFLICT_FIELDS,
    detail: { engagementId },
  })
  return row!.id
}
