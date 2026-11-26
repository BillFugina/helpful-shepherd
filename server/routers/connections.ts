import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { disconnectApp } from '../connector/connections.js'
import { oauthClient, oauthConsent } from '../db/schema.js'
import { protectedProcedure, router } from '../trpc.js'

/**
 * Apps the signed-in person has connected to their account (Claude, through
 * the connector), and the Disconnect button. Anyone signed in can see and cut
 * off their own connections, even if their role or 2FA has since changed.
 */
export const connectionsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        clientId: oauthConsent.clientId,
        name: oauthClient.name,
        uri: oauthClient.uri,
        connectedAt: oauthConsent.createdAt,
        updatedAt: oauthConsent.updatedAt,
      })
      .from(oauthConsent)
      .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
      .where(eq(oauthConsent.userId, ctx.user.id))
      .orderBy(desc(oauthConsent.updatedAt))
  }),

  disconnect: protectedProcedure
    .input(z.object({ clientId: z.string().min(1).max(200) }))
    .mutation(({ ctx, input }) => disconnectApp(ctx.db, ctx.user, input.clientId)),
})
