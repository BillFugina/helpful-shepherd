import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import { ZodError } from 'zod'
import { ADMIN_ROLE, type Grants, type Role } from '../shared/access.js'
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
}

/** Machine-readable reasons the client uses to send people to the right screen. */
export const FORBIDDEN_REASONS = {
  twoFactorRequired: 'TWO_FACTOR_REQUIRED',
  noRole: 'NO_ROLE',
  adminOnly: 'ADMIN_ONLY',
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
export const staffProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user.twoFactorEnabled) {
    throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.twoFactorRequired })
  }
  const access = await loadAccess(ctx.db, ctx.user.id)
  if (!access) throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.noRole })
  return next({ ctx: { ...ctx, role: access.role as Role, grants: access.grants as Grants } })
})

export const adminProcedure = staffProcedure.use(({ ctx, next }) => {
  if (ctx.role !== ADMIN_ROLE) throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.adminOnly })
  return next()
})
