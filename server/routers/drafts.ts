import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { draftProposal } from '../../shared/connector.js'
import { DRAFT_STATUS_LIST } from '../../shared/drafts.js'
import { decideDraft, listDrafts, requireDraftReview, viewProposal } from '../connector/drafts.js'
import { engagementDraft, person, production, season } from '../db/schema.js'
import { router, staffProcedure } from '../trpc.js'
import { friendly } from '../writes.js'

/**
 * The review queue for drafts the Claude connector made from acceptance
 * emails. A draft becomes real only when it's saved through the fast entry
 * form (engagements.quickCreate with its draftId) or is dismissed here.
 */
export const draftsRouter = router({
  list: staffProcedure
    .input(z.object({ status: z.enum(DRAFT_STATUS_LIST).default('pending') }).default({ status: 'pending' }))
    .query(async ({ ctx, input }) => {
      requireDraftReview(ctx.grants)
      const rows = await listDrafts(ctx.db, input.status)
      return rows.map((r) => {
        const parsed = draftProposal.safeParse(r.proposal)
        return {
          id: r.id,
          status: r.status,
          createdAt: r.createdAt,
          productionId: r.productionId,
          productionTitle: r.productionTitle,
          seasonName: r.seasonName,
          returningPerson: r.matchedPersonId !== null,
          engagementId: r.engagementId,
          name: parsed.success ? (parsed.data.person.preferredName ?? parsed.data.person.legalName) : null,
          role: parsed.success ? parsed.data.terms.role : null,
        }
      })
    }),

  get: staffProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    requireDraftReview(ctx.grants)
    const [row] = await ctx.db
      .select({
        draft: engagementDraft,
        productionTitle: production.title,
        seasonId: season.id,
        seasonName: season.name,
        matchedName: person.legalName,
      })
      .from(engagementDraft)
      .innerJoin(production, eq(production.id, engagementDraft.productionId))
      .innerJoin(season, eq(season.id, production.seasonId))
      .leftJoin(person, eq(person.id, engagementDraft.matchedPersonId))
      .where(eq(engagementDraft.id, input.id))
      .limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That draft no longer exists.' })
    const parsed = draftProposal.safeParse(row.draft.proposal)
    if (!parsed.success) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: 'This draft is unreadable. Dismiss it.' })
    }
    return {
      id: row.draft.id,
      status: row.draft.status,
      createdAt: row.draft.createdAt,
      production: { id: row.draft.productionId, title: row.productionTitle, seasonId: row.seasonId },
      seasonName: row.seasonName,
      matchedPerson: row.draft.matchedPersonId ? { id: row.draft.matchedPersonId, legalName: row.matchedName } : null,
      matchedAgentId: row.draft.matchedAgentId,
      engagementId: row.draft.engagementId,
      ...viewProposal(ctx.grants, parsed.data, row.draft.sourceText),
    }
  }),

  /** Throws a draft away. Nothing it proposed was ever saved. */
  dismiss: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireDraftReview(ctx.grants)
    await friendly(() => ctx.db.transaction((tx) => decideDraft(tx, ctx.user, input.id, { status: 'dismissed' })))
    return { id: input.id }
  }),
})
