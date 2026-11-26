import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, formCsrfMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { and, count, eq, gt, lt, sql } from 'drizzle-orm'
import { GUEST_EMAIL, GUEST_SESSION_SECONDS, GUEST_USER_ID } from '../../shared/access.js'
import type { Db } from '../db/client.js'
import {
  agent,
  contract,
  contractTemplate,
  engagement,
  engagementDraft,
  housingUnit,
  person,
  production,
  season,
  session,
  user,
} from '../db/schema.js'
import { env } from '../env.js'

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

/**
 * Why the guest demo is closed right now, or null when it's open.
 *
 * - off: an operator set DEMO_GUEST=off.
 * - real_data: the database holds a record that isn't fake demo data. Guests
 *   read with the same queries staff use, so the demo only runs on a database
 *   of demo records. Any record without the is_demo flag closes it, and so
 *   does any connector draft, because a draft keeps a pasted email.
 *
 * Checked when a guest signs in and again on every guest request, so turning
 * the demo off, or adding real data, takes effect at once for every open
 * guest session.
 */
export async function guestDemoClosed(db: Db): Promise<'off' | 'real_data' | null> {
  if (env().DEMO_GUEST === 'off') return 'off'
  const result = (await db.execute(sql`select (
    exists (select 1 from ${person} where ${person.isDemo} = false)
    or exists (select 1 from ${season} where ${season.isDemo} = false)
    or exists (select 1 from ${production} where ${production.isDemo} = false)
    or exists (select 1 from ${agent} where ${agent.isDemo} = false)
    or exists (select 1 from ${engagement} where ${engagement.isDemo} = false)
    or exists (select 1 from ${housingUnit} where ${housingUnit.isDemo} = false)
    or exists (select 1 from ${contractTemplate} where ${contractTemplate.isDemo} = false)
    or exists (select 1 from ${contract} where ${contract.isDemo} = false)
    or exists (select 1 from ${engagementDraft})
  ) as real`)) as unknown as { rows: { real: boolean }[] }
  return result.rows[0]?.real ? 'real_data' : null
}

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
export function demoGuest(options: { db: () => Db }) {
  return {
    id: 'demo-guest',
    endpoints: {
      signInDemoGuest: createAuthEndpoint(
        GUEST_SIGN_IN_PATH,
        { method: 'POST', use: [formCsrfMiddleware] },
        async (ctx) => {
          const db = options.db()
          const closed = await guestDemoClosed(db)
          if (closed === 'off') throw new APIError('NOT_FOUND', { message: 'The guest demo is turned off.' })
          if (closed) throw new APIError('SERVICE_UNAVAILABLE', { message: 'The demo is closed right now.' })
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
