import { GUEST_GRANTS, GUEST_ROLE, isGuestUserId, type Grants, type ViewerRole } from '../../shared/access.js'
import { loadAccess } from '../access.js'
import { checkHealth } from '../health.js'
import { publicProcedure, router } from '../trpc.js'
import { accessRouter } from './access.js'
import { agentsRouter } from './agents.js'
import { arrivalsRouter } from './arrivals.js'
import { auditRouter } from './audit.js'
import { connectionsRouter } from './connections.js'
import { contractsRouter } from './contracts.js'
import { documentsRouter, uploadLinkRouter } from './documents.js'
import { draftsRouter } from './drafts.js'
import { engagementsRouter } from './engagements.js'
import { housingRouter } from './housing.js'
import { importRouter } from './import.js'
import { passwordRouter } from './password.js'
import { peopleRouter } from './people.js'
import { productionsRouter, seasonsRouter } from './seasons.js'
import { pushRouter } from './push.js'
import { remindersRouter } from './reminders.js'
import { travelRouter } from './travel.js'

export const appRouter = router({
  health: publicProcedure.query(checkHealth),
  /** Who's signed in, and what they can reach. Null when signed out. */
  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.user) return null
    if (isGuestUserId(ctx.user.id)) {
      return { ...ctx.user, role: GUEST_ROLE as ViewerRole, grants: GUEST_GRANTS, guest: true }
    }
    // Role and grants only count once two-factor is on, matching staffProcedure.
    const access = ctx.user.twoFactorEnabled ? await loadAccess(ctx.db, ctx.user.id) : null
    const role: ViewerRole | null = access?.role ?? null
    const grants: Grants = access?.grants ?? {}
    return { ...ctx.user, role, grants, guest: false }
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
  drafts: draftsRouter,
  connections: connectionsRouter,
  contracts: contractsRouter,
  documents: documentsRouter,
  /** Automatic reminders and the morning digest. */
  reminders: remindersRouter,
  /** Phone alerts (Web Push) for this login's devices. */
  push: pushRouter,
  /** The page behind an upload link. Public: the link is the key. */
  uploadLink: uploadLinkRouter,
  /** Set or reset a staff password by email link. Public: the link is the key. */
  password: passwordRouter,
})

export type AppRouter = typeof appRouter
