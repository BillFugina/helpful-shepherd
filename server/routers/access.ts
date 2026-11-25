import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { checkGrantChange, ROLES, type Grants, type Role } from '../../shared/access.js'
import { setGrantInput } from '../../shared/schemas.js'
import { recordAudit } from '../audit.js'
import { roleGrant } from '../db/schema.js'
import { adminProcedure, router } from '../trpc.js'

export const accessRouter = router({
  /** Every role's grants, for the Company Manager's access screen. */
  matrix: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(roleGrant)
    const matrix = Object.fromEntries(ROLES.map((r) => [r, {} as Grants])) as Record<Role, Grants>
    for (const r of rows) matrix[r.role][r.fieldGroup] = r.level
    return matrix
  }),

  setGrant: adminProcedure.input(setGrantInput).mutation(async ({ ctx, input }) => {
    const check = checkGrantChange(input.role, input.fieldGroup, input.level, input.confirmSensitive)
    if (!check.ok) {
      throw new TRPCError({
        code: check.reason === 'needs_confirmation' ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
        message:
          check.reason === 'needs_confirmation'
            ? 'This group holds the most sensitive data. Confirm to grant it.'
            : "The Company Manager's access can't be changed.",
      })
    }
    const where = and(eq(roleGrant.role, input.role), eq(roleGrant.fieldGroup, input.fieldGroup))
    const [before] = await ctx.db.select({ level: roleGrant.level }).from(roleGrant).where(where).limit(1)
    const from = before?.level ?? 'none'
    if (from === input.level) return { changed: false }

    // 'none' is stored as no row, so the table only ever holds explicit grants.
    if (input.level === 'none') {
      await ctx.db.delete(roleGrant).where(where)
    } else {
      await ctx.db
        .insert(roleGrant)
        .values({ role: input.role, fieldGroup: input.fieldGroup, level: input.level })
        .onConflictDoUpdate({ target: [roleGrant.role, roleGrant.fieldGroup], set: { level: input.level } })
    }
    await recordAudit(ctx.db, {
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'grant_change',
      recordType: 'role_grant',
      recordId: `${input.role}:${input.fieldGroup}`,
      fieldGroup: input.fieldGroup,
      detail: { role: input.role, from, to: input.level, confirmed: input.confirmSensitive },
    })
    return { changed: true }
  }),
})
