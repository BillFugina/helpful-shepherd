import { loadAccess } from '../access.js'
import { checkHealth } from '../health.js'
import { publicProcedure, router } from '../trpc.js'
import { accessRouter } from './access.js'
import { agentsRouter } from './agents.js'
import { arrivalsRouter } from './arrivals.js'
import { auditRouter } from './audit.js'
import { engagementsRouter } from './engagements.js'
import { housingRouter } from './housing.js'
import { importRouter } from './import.js'
import { peopleRouter } from './people.js'
import { productionsRouter, seasonsRouter } from './seasons.js'
import { travelRouter } from './travel.js'

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
  seasons: seasonsRouter,
  productions: productionsRouter,
  agents: agentsRouter,
  engagements: engagementsRouter,
  travel: travelRouter,
  housing: housingRouter,
  arrivals: arrivalsRouter,
  import: importRouter,
  access: accessRouter,
  audit: auditRouter,
})

export type AppRouter = typeof appRouter
