import { mcp } from '@better-auth/mcp'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { jwt, twoFactor } from 'better-auth/plugins'
import { isGuestUserId } from '../shared/access.js'
import { loadAccess } from './access.js'
import { recordAudit } from './audit.js'
import { db, schema } from './db/client.js'
import { demoGuest, GUEST_AUTH_PATHS, GUEST_SIGN_IN_PATH } from './demo/guest.js'
import { appOrigin, env } from './env.js'

export const APP_NAME = 'Theatre Raleigh'

/** Where the Claude connector lives. Access tokens are issued for exactly this URL. */
export function connectorResource(origin: string = appOrigin()): string {
  return `${origin}/api/mcp`
}

/** Pages in the web app that the OAuth flow sends people to. */
export const OAUTH_LOGIN_PAGE = '/sign-in'
export const OAUTH_CONSENT_PAGE = '/connect'

/** The app asking for approval, from the signed OAuth query the consent page posts back. */
function clientIdFromQuery(body: unknown): string | null {
  const query = (body as { oauth_query?: unknown } | null)?.oauth_query
  if (typeof query !== 'string') return null
  return new URLSearchParams(query).get('client_id')
}

function createAuth() {
  const e = env()
  const origin = appOrigin(e)
  return betterAuth({
    appName: APP_NAME,
    secret: e.BETTER_AUTH_SECRET,
    baseURL: origin,
    basePath: '/api/auth',
    trustedOrigins: [origin],
    database: drizzleAdapter(db(), {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
        rateLimit: schema.rateLimit,
        jwks: schema.jwks,
        oauthClient: schema.oauthClient,
        oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource,
        oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken,
        oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // Staff accounts are created by the seed script (later: by the Company
      // Manager). Nobody can sign themselves up.
      disableSignUp: true,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 12, // 12 hours
      updateAge: 60 * 60, // refresh at most hourly
    },
    // Connected apps are listed and disconnected through the app's own API
    // (connections router), which also revokes tokens and writes the audit log.
    disabledPaths: ['/oauth2/get-consents', '/oauth2/get-consent', '/oauth2/update-consent', '/oauth2/delete-consent'],
    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/two-factor/*': { window: 60, max: 5 },
        // Open registration is how Claude introduces itself; keep it from being a firehose.
        '/oauth2/register': { window: 60, max: 10 },
        // "Try the demo" makes a session per tap; keep one visitor from piling them up.
        [GUEST_SIGN_IN_PATH]: { window: 60, max: 5 },
      },
    },
    plugins: [
      // Required for every staff account: the API refuses all data calls until
      // two-factor is on (see staffProcedure in trpc.ts).
      twoFactor({ issuer: APP_NAME }),
      // Signs the connector's access tokens.
      jwt({ disableSettingJwtHeader: true }),
      // The Claude connector's sign-in: an OAuth 2.1 server for the MCP
      // endpoint. Claude registers itself, then sends the person here to sign
      // in (with 2FA) and approve. Tokens only open /api/mcp, and the endpoint
      // checks the approval, role and 2FA again on every call (server/mcp.ts).
      mcp({
        resource: connectorResource(origin),
        loginPage: OAUTH_LOGIN_PAGE,
        consentPage: OAUTH_CONSENT_PAGE,
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Lets the sign-in page show which app is asking before anyone signs in.
        allowPublicClientPrelogin: true,
        clientRegistrationRequirePKCE: true,
        accessTokenExpiresIn: 60 * 60, // 1 hour
        refreshTokenExpiresIn: 60 * 60 * 24 * 30, // 30 days, unless disconnected sooner
        storeTokens: 'hashed',
        storeClientSecret: 'hashed',
        // Apps register themselves through /oauth2/register only. Signed-in
        // staff can't create, list, change or delete OAuth clients.
        clientPrivileges: () => false,
      }),
      // The public guest demo's sign-in (server/demo/guest.ts).
      demoGuest({ db, enabled: () => e.DEMO_GUEST !== 'off' }),
    ],
    hooks: {
      // Only staff with 2FA on can connect an app. The consent page checks
      // too, but this is the gate that counts.
      before: createAuthMiddleware(async (ctx) => {
        // The guest account is shared by every visitor, so a guest session can
        // only read itself and sign out: no listing or revoking sessions, no
        // account changes, no two-factor setup, no connecting an app.
        if (!GUEST_AUTH_PATHS.has(ctx.path)) {
          const current = await getSessionFromCtx(ctx)
          if (current && isGuestUserId(current.user.id)) {
            throw new APIError('FORBIDDEN', { message: 'The guest demo is read-only.' })
          }
        }
        if (ctx.path !== '/oauth2/consent') return
        const body = ctx.body as { accept?: unknown } | undefined
        if (body?.accept !== true) return
        const session = await getSessionFromCtx(ctx)
        if (!session) return // the endpoint itself answers 401
        if (session.user.twoFactorEnabled !== true) {
          throw new APIError('FORBIDDEN', { message: 'Turn on two-factor sign-in before connecting an app.' })
        }
        if (!(await loadAccess(db(), session.user.id))) {
          throw new APIError('FORBIDDEN', { message: 'Your account has no role yet, so there is nothing to connect.' })
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/oauth2/consent') return
        const body = ctx.body as { accept?: unknown } | undefined
        if (body?.accept !== true || ctx.context.returned instanceof Error) return
        const session = await getSessionFromCtx(ctx)
        if (!session) return
        await recordAudit(db(), {
          actorId: session.user.id,
          actorEmail: session.user.email,
          action: 'connect',
          recordType: 'oauth_client',
          recordId: clientIdFromQuery(ctx.body) ?? undefined,
        })
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // A session exists only after the second factor (when it's on), so
          // this logs completed sign-ins.
          after: async (session) => {
            // Guest demo sessions aren't logged: anyone can start one, and the
            // audit log is append-only, so they'd bury the staff sign-ins.
            if (isGuestUserId(session.userId)) return
            await recordAudit(db(), { actorId: session.userId, action: 'sign_in' })
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>

let cached: Auth | undefined

export function auth(): Auth {
  cached ??= createAuth()
  return cached
}
