import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, formCsrfMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { and, count, eq, gt, lt } from 'drizzle-orm'
import { GUEST_EMAIL, GUEST_SESSION_SECONDS, GUEST_USER_ID } from '../../shared/access.js'
import type { Db } from '../db/client.js'
import { session, user } from '../db/schema.js'

/** The sign-in path, under /api/auth. */
export const GUEST_SIGN_IN_PATH = '/demo/guest'

/**
 * Better Auth paths a guest session may use. Everything else that reads the
 * session (list or revoke sessions, update the account, start two-factor,
 * connect an app) is refused for the guest, because the account is shared by
 * every visitor. Sign-in paths stay open so a staff member can sign in over a
 * leftover guest session.
 */
export const GUEST_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/get-session',
  '/sign-out',
  GUEST_SIGN_IN_PATH,
  '/sign-in/email',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
])

/** Past this many live guest sessions, new visitors are asked to come back later. Keeps a free tier safe. */
export const MAX_GUEST_SESSIONS = 1000

/** Creates the shared guest account if it isn't there yet. No password, no role row, two-factor off. */
export async function ensureGuestUser(db: Db): Promise<void> {
  await db
    .insert(user)
    .values({ id: GUEST_USER_ID, email: GUEST_EMAIL, name: 'Demo guest', emailVerified: false })
    .onConflictDoNothing()
}

/**
 * "Try the demo": signs the visitor in as the shared guest account, with no
 * password and no second factor, for GUEST_SESSION_SECONDS. The session
 * isn't refreshed (it's a "don't remember me" session), the path is rate
 * limited per IP (auth.ts), and the number of live guest sessions is capped.
 * What the guest can do once signed in is decided on the server: read-only,
 * fixed grants (trpc.ts, shared/access.ts).
 */
export function demoGuest(options: { db: () => Db; enabled: () => boolean }) {
  return {
    id: 'demo-guest',
    endpoints: {
      signInDemoGuest: createAuthEndpoint(
        GUEST_SIGN_IN_PATH,
        { method: 'POST', use: [formCsrfMiddleware] },
        async (ctx) => {
          if (!options.enabled()) throw new APIError('NOT_FOUND', { message: 'The guest demo is turned off.' })
          const db = options.db()
          const now = new Date()
          await ensureGuestUser(db)
          // Housekeeping: guest sessions that ran out are never used again.
          await db.delete(session).where(and(eq(session.userId, GUEST_USER_ID), lt(session.expiresAt, now)))
          const [live] = await db
            .select({ n: count() })
            .from(session)
            .where(and(eq(session.userId, GUEST_USER_ID), gt(session.expiresAt, now)))
          if ((live?.n ?? 0) >= MAX_GUEST_SESSIONS) {
            throw new APIError('SERVICE_UNAVAILABLE', { message: 'The demo is busy right now. Try again later.' })
          }
          const guest = await ctx.context.internalAdapter.findUserById(GUEST_USER_ID)
          if (!guest) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'The guest account is missing.' })
          // overrideAll so our expiry wins over the one-day "don't remember me" default.
          const created = await ctx.context.internalAdapter.createSession(
            GUEST_USER_ID,
            true,
            { expiresAt: new Date(now.getTime() + GUEST_SESSION_SECONDS * 1000) },
            true,
          )
          if (!created) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not start the demo.' })
          await setSessionCookie(ctx, { session: created, user: guest }, true)
          return ctx.json({ ok: true, expiresAt: created.expiresAt })
        },
      ),
    },
  } satisfies BetterAuthPlugin
}
