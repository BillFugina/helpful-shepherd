import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { isGuestUserId } from '../../shared/access.js'
import { PASSWORD_MAX, PASSWORD_MIN, requestSetPassword, setPasswordWithToken } from '../staff/set-password.js'
import { FORBIDDEN_REASONS, publicProcedure, router, type Context } from '../trpc.js'

/** The guest demo and Claude's connector never reach these. */
function refuseGuestAndConnector(ctx: Context) {
  if (ctx.via === 'connector') {
    throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.readOnlyConnector })
  }
  if (ctx.user && isGuestUserId(ctx.user.id)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.demoReadOnly })
  }
}

/**
 * Set or reset a staff password by email link. Public, like any "forgot
 * password" form, but the link only goes to the login's own address, so asking
 * for one gets the asker nothing. Nobody can make a login here.
 */
export const passwordRouter = router({
  requestLink: publicProcedure.input(z.object({ email: z.email().max(254) })).mutation(async ({ ctx, input }) => {
    refuseGuestAndConnector(ctx)
    await requestSetPassword(ctx.db, input.email)
    return { ok: true as const }
  }),

  set: publicProcedure
    .input(
      z.object({
        token: z.string().min(20).max(128),
        password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      refuseGuestAndConnector(ctx)
      const result = await setPasswordWithToken(ctx.db, input.token, input.password)
      if (result === 'invalid') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This link has expired or was already used. Ask for a new one.',
        })
      }
      return { ok: true as const }
    }),
})
