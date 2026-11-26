import { and, eq, isNull, sql } from 'drizzle-orm'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from '../db/schema.js'
import type { SessionUser } from '../trpc.js'

/** Is this app still connected to this person? Checked on every connector call. */
export async function isConnected(db: Db, userId: string, clientId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(
      and(
        eq(oauthConsent.userId, userId),
        eq(oauthConsent.clientId, clientId),
        // A disabled client is cut off too.
        sql`coalesce(${oauthClient.disabled}, false) = false`,
      ),
    )
    .limit(1)
  return !!row
}

/**
 * Cuts an app off: removes the person's approval and revokes its tokens. The
 * connector checks the approval on every call, so this takes effect at once,
 * even for an access token that hasn't expired yet.
 */
export async function disconnectApp(db: Db, user: SessionUser, clientId: string): Promise<{ disconnected: boolean }> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(oauthConsent)
      .where(and(eq(oauthConsent.userId, user.id), eq(oauthConsent.clientId, clientId)))
      .returning({ id: oauthConsent.id })
    const now = new Date()
    await tx
      .update(oauthRefreshToken)
      .set({ revoked: now })
      .where(
        and(
          eq(oauthRefreshToken.userId, user.id),
          eq(oauthRefreshToken.clientId, clientId),
          isNull(oauthRefreshToken.revoked),
        ),
      )
    await tx
      .update(oauthAccessToken)
      .set({ revoked: now })
      .where(
        and(
          eq(oauthAccessToken.userId, user.id),
          eq(oauthAccessToken.clientId, clientId),
          isNull(oauthAccessToken.revoked),
        ),
      )
    if (removed.length) {
      await recordAudit(tx, {
        actorId: user.id,
        actorEmail: user.email,
        action: 'disconnect',
        recordType: 'oauth_client',
        recordId: clientId,
        via: 'app',
      })
    }
    return { disconnected: removed.length > 0 }
  })
}
