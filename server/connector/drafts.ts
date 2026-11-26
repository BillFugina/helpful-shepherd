import { TRPCError } from '@trpc/server'
import { and, desc, eq, sql } from 'drizzle-orm'
import { levelAtLeast, levelFor, type Grants } from '../../shared/access.js'
import { draftProposal, type DraftProposal } from '../../shared/connector.js'
import type { DraftStatus } from '../../shared/drafts.js'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import { agent, engagementDraft, person, production, season } from '../db/schema.js'
import { requireProduction } from '../roster/create.js'
import type { SessionUser } from '../trpc.js'

/** Who may make, see and decide drafts: the people who could save the engagement themselves. */
export function canReviewDrafts(grants: Grants): boolean {
  return levelAtLeast(levelFor(grants, 'general'), 'edit')
}

export function requireDraftReview(grants: Grants): void {
  if (!canReviewDrafts(grants)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Your role can view the roster but not add to it.' })
  }
}

/** A returning person, matched on email first, then on the exact legal name. */
async function matchPerson(db: Db, p: DraftProposal['person']): Promise<string | null> {
  if (p.email) {
    const [row] = await db
      .select({ id: person.id })
      .from(person)
      .where(eq(sql`lower(${person.email})`, p.email.toLowerCase()))
      .limit(1)
    if (row) return row.id
  }
  const rows = await db
    .select({ id: person.id })
    .from(person)
    .where(eq(sql`lower(${person.legalName})`, p.legalName.toLowerCase()))
    .limit(2)
  // Two people with the same name: leave it to the reviewer.
  return rows.length === 1 ? rows[0]!.id : null
}

/** An agent already in the app, matched on email first, then on the exact name. */
async function matchAgent(db: Db, a: DraftProposal['agent']): Promise<string | null> {
  if (!a) return null
  if (a.email) {
    const [row] = await db
      .select({ id: agent.id })
      .from(agent)
      .where(eq(sql`lower(${agent.email})`, a.email.toLowerCase()))
      .limit(1)
    if (row) return row.id
  }
  const rows = await db
    .select({ id: agent.id })
    .from(agent)
    .where(eq(sql`lower(${agent.name})`, a.name.toLowerCase()))
    .limit(2)
  return rows.length === 1 ? rows[0]!.id : null
}

/**
 * Saves what the connector proposed as a pending draft. Nothing else is
 * written: the person, agent and engagement only exist once the Company
 * Manager reviews the draft and saves it in the app.
 */
export async function createDraft(
  db: Db,
  user: SessionUser,
  input: { productionId: string; emailText: string; proposal: DraftProposal },
): Promise<{ id: string; matchedPersonId: string | null; matchedAgentId: string | null }> {
  const proposal = draftProposal.parse(input.proposal)
  await requireProduction(db, input.productionId)
  const matchedPersonId = await matchPerson(db, proposal.person)
  const matchedAgentId = await matchAgent(db, proposal.agent)
  // The draft and its audit event commit together.
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(engagementDraft)
      .values({
        productionId: input.productionId,
        createdBy: user.id,
        createdVia: 'connector',
        sourceText: input.emailText,
        proposal,
        matchedPersonId,
        matchedAgentId,
      })
      .returning({ id: engagementDraft.id })
    const id = row!.id
    await recordAudit(tx, {
      actorId: user.id,
      actorEmail: user.email,
      action: 'create',
      recordType: 'engagement_draft',
      recordId: id,
      personId: matchedPersonId ?? undefined,
      via: 'connector',
      detail: { productionId: input.productionId, returningPerson: matchedPersonId !== null },
    })
    return { id, matchedPersonId, matchedAgentId }
  })
}

/**
 * A draft's proposal as this viewer may see it: contact details only with
 * Contact, pay only with Pay terms. The pasted email holds both, so it shows
 * only to someone who can see both.
 */
export function viewProposal(grants: Grants, proposal: DraftProposal, sourceText: string | null) {
  const seesContact = levelAtLeast(levelFor(grants, 'contact'), 'view')
  const seesPay = levelAtLeast(levelFor(grants, 'pay_terms'), 'view')
  const { weeklyPayCents, commissionPercent, weeklyStipendCents, ...terms } = proposal.terms
  return {
    person: {
      legalName: proposal.person.legalName,
      preferredName: proposal.person.preferredName ?? null,
      ...(seesContact
        ? {
            email: proposal.person.email ?? null,
            cell: proposal.person.cell ?? null,
            homeAirport: proposal.person.homeAirport ?? null,
            airportPrefs: proposal.person.airportPrefs ?? null,
          }
        : {}),
    },
    agent: seesContact ? proposal.agent : undefined,
    terms: seesPay ? { ...terms, weeklyPayCents, commissionPercent, weeklyStipendCents } : terms,
    conflicts: proposal.conflicts,
    sourceText: seesContact && seesPay ? sourceText : undefined,
  }
}

export async function listDrafts(db: Db, status: DraftStatus) {
  return db
    .select({
      id: engagementDraft.id,
      status: engagementDraft.status,
      createdAt: engagementDraft.createdAt,
      createdVia: engagementDraft.createdVia,
      productionId: engagementDraft.productionId,
      productionTitle: production.title,
      seasonName: season.name,
      proposal: engagementDraft.proposal,
      matchedPersonId: engagementDraft.matchedPersonId,
      engagementId: engagementDraft.engagementId,
    })
    .from(engagementDraft)
    .innerJoin(production, eq(production.id, engagementDraft.productionId))
    .innerJoin(season, eq(season.id, production.seasonId))
    .where(eq(engagementDraft.status, status))
    .orderBy(desc(engagementDraft.createdAt))
    .limit(100)
}

/**
 * Marks a pending draft decided, in the caller's transaction. Locks the row so
 * a draft can't be saved twice (two tabs, a double tap).
 */
export async function decideDraft(
  tx: Db,
  user: SessionUser,
  draftId: string,
  outcome:
    { status: 'accepted'; engagementId: string; personId: string; productionId: string } | { status: 'dismissed' },
): Promise<void> {
  const [row] = await tx
    .select({ id: engagementDraft.id, status: engagementDraft.status, productionId: engagementDraft.productionId })
    .from(engagementDraft)
    .where(eq(engagementDraft.id, draftId))
    .for('update')
    .limit(1)
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That draft no longer exists.' })
  if (row.status !== 'pending') {
    throw new TRPCError({ code: 'CONFLICT', message: `That draft was already ${row.status}.` })
  }
  if (outcome.status === 'accepted' && outcome.productionId !== row.productionId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That draft is for a different production.' })
  }
  await tx
    .update(engagementDraft)
    .set({
      status: outcome.status,
      engagementId: outcome.status === 'accepted' ? outcome.engagementId : null,
      decidedAt: new Date(),
      decidedBy: user.id,
      // The pasted email has done its job once the draft is decided.
      sourceText: null,
    })
    .where(and(eq(engagementDraft.id, draftId), eq(engagementDraft.status, 'pending')))
  await recordAudit(tx, {
    actorId: user.id,
    actorEmail: user.email,
    action: 'update',
    recordType: 'engagement_draft',
    recordId: draftId,
    personId: outcome.status === 'accepted' ? outcome.personId : undefined,
    detail: { status: outcome.status },
  })
}
