import { desc, eq, sql } from 'drizzle-orm'
import { auditListInput } from '../../shared/schemas.js'
import { auditEvent, person, user } from '../db/schema.js'
import { adminProcedure, router } from '../trpc.js'

export const auditRouter = router({
  /** Newest first. The Company Manager can filter by person. */
  list: adminProcedure.input(auditListInput).query(async ({ ctx, input }) => {
    return ctx.db
      .select({
        id: auditEvent.id,
        at: auditEvent.at,
        actorEmail: sql<string | null>`coalesce(${auditEvent.actorEmail}, ${user.email})`,
        action: auditEvent.action,
        recordType: auditEvent.recordType,
        recordId: auditEvent.recordId,
        personId: auditEvent.personId,
        personName: person.legalName,
        fieldGroup: auditEvent.fieldGroup,
        via: auditEvent.via,
        detail: auditEvent.detail,
      })
      .from(auditEvent)
      .leftJoin(person, eq(person.id, auditEvent.personId))
      .leftJoin(user, eq(user.id, auditEvent.actorId))
      .where(input.personId ? eq(auditEvent.personId, input.personId) : undefined)
      .orderBy(desc(auditEvent.at))
      .limit(input.limit)
  }),
})
