import { loadAccess } from '../access.js'
import { checkHealth } from '../health.js'
import { publicProcedure, router } from '../trpc.js'
import { accessRouter } from './access.js'
import { auditRouter } from './audit.js'
import { peopleRouter } from './people.js'

export const appRouter = router({
  health: publicProcedure.query(checkHealth),
  /** Who's signed in, and what they can reach. Null when signed out. */
  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.user) return null
    // Role and grants only count once two-factor is on, matching staffProcedure.
    const access = ctx.user.twoFactorEnabled ? await loadAccess(ctx.db, ctx.user.id) : null
    return { ...ctx.user, role: access?.role ?? null, grants: access?.grants ?? {} }
  }),
  people: peopleRouter,
  access: accessRouter,
  audit: auditRouter,
})

export type AppRouter = typeof appRouter
