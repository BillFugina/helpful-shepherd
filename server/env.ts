import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  // 32 random bytes, base64url. Encrypts DOB and travel IDs before they reach the database.
  FIELD_ENCRYPTION_KEY: z.string().optional(),
  // The public "Try the demo" guest sign-in. On unless set to off.
  DEMO_GUEST: z.enum(['on', 'off']).optional(),
  // Optional: defaults to the Vercel deployment URL, or localhost in dev.
  BETTER_AUTH_URL: z.url().optional(),
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
  VERCEL_URL: z.string().optional(),
  VERCEL_BRANCH_URL: z.string().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
})

export type Env = z.infer<typeof schema>

let cached: Env | undefined

/** Reads and validates server env vars once, on first use (not at import time). */
export function env(): Env {
  cached ??= schema.parse(process.env)
  return cached
}

/** Tests that change process.env call this so the next env() reads it again. */
export function resetEnvForTests(): void {
  cached = undefined
}

/** The public origin this deployment answers on. */
export function appOrigin(e: Env = env()): string {
  if (e.BETTER_AUTH_URL) return e.BETTER_AUTH_URL
  if (e.VERCEL_ENV === 'production' && e.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${e.VERCEL_PROJECT_PRODUCTION_URL}`
  }
  if (e.VERCEL_BRANCH_URL) return `https://${e.VERCEL_BRANCH_URL}`
  if (e.VERCEL_URL) return `https://${e.VERCEL_URL}`
  return 'http://localhost:5173'
}
