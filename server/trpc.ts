import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import { ZodError } from 'zod'
import { ADMIN_ROLE, NEVER_OVER_CONNECTOR, type Grants } from '../shared/access.js'
import { loadAccess } from './access.js'
import type { Db } from './db/client.js'

export interface SessionUser {
  id: string
  email: string
  name: string
  twoFactorEnabled: boolean
}

export interface Context {
  db: Db
  user: SessionUser | null
  /**
   * Who is asking: the web app, or Ash's Claude through the connector. The
   * connector reads with the same procedures and filters, minus the field
   * groups that never go over it, and can't call any mutation.
   */
  via?: 'app' | 'connector'
}

/** The grants the connector works with: the person's own, minus the groups that never go over it. */
export function connectorGrants(grants: Grants): Grants {
  const out: Grants = {}
  for (const [group, level] of Object.entries(grants) as [keyof Grants, Grants[keyof Grants]][]) {
    if (!NEVER_OVER_CONNECTOR.has(group)) out[group] = level
  }
  return out
}

/** Machine-readable reasons the client uses to send people to the right screen. */
export const FORBIDDEN_REASONS = {
  twoFactorRequired: 'TWO_FACTOR_REQUIRED',
  noRole: 'NO_ROLE',
  adminOnly: 'ADMIN_ONLY',
  readOnlyConnector: 'CONNECTOR_READ_ONLY',
} as const

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    }
  },
})

export const router = t.router
export const createCallerFactory = t.createCallerFactory
export const publicProcedure = t.procedure

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
  return next({ ctx: { ...ctx, user: ctx.user } })
})

/**
 * Every data procedure goes through here: signed in, two-factor on, and a
 * staff role. The role's grants ride along in ctx for the field filter.
 */
export const staffProcedure = protectedProcedure.use(async ({ ctx, next, type }) => {
  if (!ctx.user.twoFactorEnabled) {
    throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.twoFactorRequired })
  }
  // The connector reads; its one write (a draft) doesn't go through tRPC.
  if (ctx.via === 'connector' && type !== 'query') {
    throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.readOnlyConnector })
  }
  const access = await loadAccess(ctx.db, ctx.user.id)
  if (!access) throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.noRole })
  const grants = ctx.via === 'connector' ? connectorGrants(access.grants) : access.grants
  return next({ ctx: { ...ctx, role: access.role, grants } })
})

export const adminProcedure = staffProcedure.use(({ ctx, next }) => {
  if (ctx.role !== ADMIN_ROLE) throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.adminOnly })
  return next()
})
