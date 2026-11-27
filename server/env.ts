import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  // 32 random bytes, base64url. Encrypts DOB and travel IDs before they reach the database.
  FIELD_ENCRYPTION_KEY: z.string().optional(),
  // The public "Try the demo" guest sign-in. On unless set to off.
  DEMO_GUEST: z.enum(['on', 'off']).optional(),
  // Outgoing email (reminders). With no key, nothing is sent: the app shows
  // the email for the Company Manager to copy instead.
  RESEND_API_KEY: z.string().optional(),
  // e.g. "Theatre Raleigh <reminders@example.org>", on a domain verified in Resend.
  EMAIL_FROM: z.string().optional(),
  // log (default): never send. allowlist: send only to EMAIL_ALLOWLIST.
  // live: send to real people; demo people still only to the allowlist.
  EMAIL_DELIVERY: z.enum(['log', 'allowlist', 'live']).optional(),
  // Comma-separated addresses that may get email in allowlist mode (and demo people in live mode).
  EMAIL_ALLOWLIST: z.string().optional(),
  // Flight alerts and the arriving-tomorrow email (Inngest). Without a signing
  // key /api/inngest is off and no emails go out on their own.
  // The Inngest Vercel integration sets both.
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
  // AeroDataBox (bought directly), for live flight updates pushed to
  // /api/flight-push. With a key, staff can run a live test on any real flight.
  AERODATABOX_API_KEY: z.string().optional(),
  // Automatic credit top-up (server/flights/credits.ts): whole numbers, read
  // there with defaults 100, 500 and 10000. 0 for the amount or cap turns it off.
  AERODATABOX_TOP_UP_BELOW: z.string().optional(),
  AERODATABOX_TOP_UP_AMOUNT: z.string().optional(),
  AERODATABOX_TOP_UP_MONTHLY_MAX: z.string().optional(),
  // simulated (default): the demo feed. aerodatabox: booked flights are watched
  // by AeroDataBox from 3 hours before take-off until they land.
  FLIGHT_FEED: z.enum(['simulated', 'aerodatabox']).optional(),
  // Phone alerts (Web Push). Both VAPID keys, from `npx web-push generate-vapid-keys`.
  // Without them, phone alerts are off and the settings page says so.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  // Who runs this server, for the push services: an https URL or mailto:.
  // Defaults to the app's own address.
  VAPID_SUBJECT: z.string().optional(),
  // off (default): never send. allowlist: only to logins in PUSH_ALLOWLIST.
  // live: to every Company Manager who turned alerts on. Demo logins never get one.
  PUSH_DELIVERY: z.enum(['off', 'allowlist', 'live']).optional(),
  // Comma-separated login emails that may get phone alerts in allowlist mode.
  PUSH_ALLOWLIST: z.string().optional(),
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
