import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { twoFactor } from 'better-auth/plugins'
import { recordAudit } from './audit.js'
import { db, schema } from './db/client.js'
import { appOrigin, env } from './env.js'

export const APP_NAME = 'Theatre Raleigh'

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
    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/two-factor/*': { window: 60, max: 5 },
      },
    },
    plugins: [
      // Required for every staff account: the API refuses all data calls until
      // two-factor is on (see staffProcedure in trpc.ts).
      twoFactor({ issuer: APP_NAME }),
    ],
    databaseHooks: {
      session: {
        create: {
          // A session exists only after the second factor (when it's on), so
          // this logs completed sign-ins.
          after: async (session) => {
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
