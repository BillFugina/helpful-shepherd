import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { flight, flightPush, flightSubscription, user } from '../db/schema.js'
import {
  adbClient,
  hashToken,
  isFinal,
  newToken,
  parseUtc,
  pickMatch,
  subjectFor,
  toLiveState,
  type AdbClient,
  type AdbFlightItem,
  type AdbMovement,
  type AdbNotification,
} from './aerodatabox.js'
import { applyState } from './track.js'

// AeroDataBox push subscriptions: one shared subscription per flight number
// while booked flights with that number are in the air, plus short staff
// tests on any real flight. See server/inngest/functions.ts for when each
// starts and stops.

export type Subscription = typeof flightSubscription.$inferSelect

/** The AeroDataBox client, or null when no key is set. */
export function adbFromEnv(e: NodeJS.ProcessEnv = process.env): AdbClient | null {
  return e.AERODATABOX_API_KEY ? adbClient(e.AERODATABOX_API_KEY) : null
}

export const callbackUrl = (origin: string, token: string) => `${origin}/api/flight-push/${token}`

/** Below this many credits the Company Manager gets a warning (once a day). */
export const LOW_CREDITS = 25
/** A test watches its flight for at most this long. */
export const TEST_HOURS = 12
/** How many tests may run at once, to keep credits safe. */
export const MAX_TESTS = 2

/**
 * Makes the subscription row first (so the token is known before AeroDataBox
 * can call), then subscribes. If subscribing fails, the row is removed.
 * Returns null if another flight just made the shared one.
 */
async function createSubscription(
  db: Db,
  api: AdbClient,
  input: { flightNumber: string; purpose: 'flight' | 'test'; startedBy?: string; origin: string },
): Promise<Subscription | null> {
  const token = newToken()
  const [row] = await db
    .insert(flightSubscription)
    .values({
      flightNumber: input.flightNumber,
      tokenHash: hashToken(token),
      purpose: input.purpose,
      startedBy: input.startedBy ?? null,
    })
    .onConflictDoNothing()
    .returning()
  if (!row) return null
  try {
    const { id } = await api.subscribe(input.flightNumber, callbackUrl(input.origin, token))
    const [done] = await db
      .update(flightSubscription)
      .set({ providerId: id })
      .where(eq(flightSubscription.id, row.id))
      .returning()
    return done ?? row
  } catch (error) {
    await db.delete(flightSubscription).where(eq(flightSubscription.id, row.id))
    throw error
  }
}

const liveShared = (db: Db, flightNumber: string) =>
  db
    .select()
    .from(flightSubscription)
    .where(
      and(
        eq(flightSubscription.flightNumber, flightNumber),
        eq(flightSubscription.purpose, 'flight'),
        eq(flightSubscription.active, true),
      ),
    )
    .limit(1)

/**
 * Starts watching a booked flight: joins the live subscription for its number,
 * or creates one. Does nothing for a flight that's gone, finished or already
 * watched. Returns the subscription id.
 */
export async function watchFlight(db: Db, api: AdbClient, flightId: string, origin: string): Promise<string | null> {
  const [f] = await db.select().from(flight).where(eq(flight.id, flightId))
  if (!f || f.pushSubscriptionId || f.liveStatus === 'landed' || f.liveStatus === 'cancelled') return null
  const number = subjectFor(f.airline, f.flightNumber)
  let [sub] = await liveShared(db, number)
  if (!sub) {
    sub = (await createSubscription(db, api, { flightNumber: number, purpose: 'flight', origin })) ?? undefined
    // Lost a race with another flight on the same number: use theirs.
    if (!sub) [sub] = await liveShared(db, number)
  }
  if (!sub) return null
  await db.update(flight).set({ pushSubscriptionId: sub.id }).where(eq(flight.id, f.id))
  return sub.id
}

/** Removes a subscription at AeroDataBox and marks it ended. Safe to call twice. */
export async function endSubscription(db: Db, api: AdbClient, subscriptionId: string): Promise<boolean> {
  const [sub] = await db.select().from(flightSubscription).where(eq(flightSubscription.id, subscriptionId))
  if (!sub?.active) return false
  if (sub.providerId) await api.unsubscribe(sub.providerId)
  await db.update(flightSubscription).set({ active: false }).where(eq(flightSubscription.id, sub.id))
  return true
}

/** Ends a shared subscription once no booked flight uses it. */
export async function releaseIfUnused(db: Db, api: AdbClient, subscriptionId: string | null): Promise<boolean> {
  if (!subscriptionId) return false
  const [sub] = await db.select().from(flightSubscription).where(eq(flightSubscription.id, subscriptionId))
  if (!sub?.active || sub.purpose !== 'flight') return false
  const [use] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(flight)
    .where(eq(flight.pushSubscriptionId, subscriptionId))
  if ((use?.n ?? 0) > 0) return false
  return endSubscription(db, api, subscriptionId)
}

/** Stops watching one flight, and ends its subscription if nothing else needs it. */
export async function releaseFlight(db: Db, api: AdbClient, flightId: string): Promise<boolean> {
  const [f] = await db.select({ sub: flight.pushSubscriptionId }).from(flight).where(eq(flight.id, flightId))
  if (!f?.sub) return false
  await db.update(flight).set({ pushSubscriptionId: null }).where(eq(flight.id, flightId))
  return releaseIfUnused(db, api, f.sub)
}

/** A staff test: watch any real flight number for a while and see what arrives. */
export async function startTest(
  db: Db,
  api: AdbClient,
  input: { flightNumber: string; userId: string; origin: string },
): Promise<Subscription> {
  const number = input.flightNumber.toUpperCase().replace(/\s+/g, '')
  if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(number)) throw new Error('Use a flight number like B6 1017.')
  const [running] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(flightSubscription)
    .where(and(eq(flightSubscription.purpose, 'test'), eq(flightSubscription.active, true)))
  if ((running?.n ?? 0) >= MAX_TESTS) throw new Error(`Only ${MAX_TESTS} tests can run at once. Stop one first.`)
  const sub = await createSubscription(db, api, {
    flightNumber: number,
    purpose: 'test',
    startedBy: input.userId,
    origin: input.origin,
  })
  if (!sub) throw new Error('Could not start the test.')
  return sub
}

/** Recent tests with what each received, newest first. Flight data only. */
export async function listTests(db: Db) {
  const subs = await db
    .select()
    .from(flightSubscription)
    .where(eq(flightSubscription.purpose, 'test'))
    .orderBy(desc(flightSubscription.createdAt))
    .limit(5)
  const pushes = subs.length
    ? await db
        .select()
        .from(flightPush)
        .where(
          inArray(
            flightPush.subscriptionId,
            subs.map((s) => s.id),
          ),
        )
        .orderBy(desc(flightPush.receivedAt))
        .limit(100)
    : []
  return subs.map((s) => ({
    id: s.id,
    flightNumber: s.flightNumber,
    active: s.active,
    subscribed: !!s.providerId,
    startedAt: s.createdAt,
    endsAt: new Date(s.createdAt.getTime() + TEST_HOURS * 3_600_000),
    lastPushAt: s.lastPushAt,
    creditsRemaining: s.creditsRemaining,
    pushes: pushes
      .filter((p) => p.subscriptionId === s.id)
      .slice(0, 20)
      .map((p) => ({
        id: p.id,
        receivedAt: p.receivedAt,
        number: p.number,
        status: p.status,
        fromAirport: p.fromAirport,
        toAirport: p.toAirport,
        scheduledDeparture: p.scheduledDeparture,
        summary: typeof p.detail?.summary === 'string' ? p.detail.summary : null,
      })),
  }))
}

const movement = (m: AdbMovement | null | undefined) => ({
  scheduled: m?.scheduledTime?.utc ?? null,
  revised: m?.revisedTime?.utc ?? null,
  predicted: m?.predictedTime?.utc ?? null,
  runway: m?.runwayTime?.utc ?? null,
  terminal: m?.terminal ?? null,
  gate: m?.gate ?? null,
  baggage: m?.baggageBelt ?? null,
})

const short = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null)

export interface PushResult {
  purpose: 'flight' | 'test' | null
  stored: number
  /** Changes logged on booked flights (these get alert emails). */
  events: number
  /** Booked flights that landed or were cancelled: stop watching them. */
  finished: string[]
  /** A test whose flight landed or was cancelled. */
  testFinished: boolean
  /** Test status changes, one line each, for the email to whoever started it. */
  testLines: string[]
  startedBy: string | null
  credits: number | null
}

/**
 * Handles one push. Keeps each flight item (flight data only), notes the
 * credit balance, and for a shared subscription applies the matching update
 * to each booked flight with that number.
 */
export async function applyPush(
  db: Db,
  subscriptionId: string,
  payload: AdbNotification,
  now: Date,
): Promise<PushResult> {
  const empty: PushResult = {
    purpose: null,
    stored: 0,
    events: 0,
    finished: [],
    testFinished: false,
    testLines: [],
    startedBy: null,
    credits: null,
  }
  const [sub] = await db.select().from(flightSubscription).where(eq(flightSubscription.id, subscriptionId))
  if (!sub?.active) return empty
  const items: AdbFlightItem[] = Array.isArray(payload.flights) ? payload.flights.slice(0, 50) : []
  const credits = typeof payload.balance?.creditsRemaining === 'number' ? payload.balance.creditsRemaining : null

  const [previous] = await db
    .select({ status: flightPush.status })
    .from(flightPush)
    .where(eq(flightPush.subscriptionId, sub.id))
    .orderBy(desc(flightPush.receivedAt))
    .limit(1)
  if (items.length) {
    await db.insert(flightPush).values(
      items.map((i) => ({
        subscriptionId: sub.id,
        receivedAt: now,
        number: short(i.number, 20) ?? '?',
        status: short(i.status, 40) ?? 'Unknown',
        fromAirport: short(i.departure?.airport?.iata, 4),
        toAirport: short(i.arrival?.airport?.iata, 4),
        scheduledDeparture: parseUtc(i.departure?.scheduledTime?.utc),
        detail: {
          summary: short(i.notificationSummary),
          remark: short(i.notificationRemark),
          departure: movement(i.departure),
          arrival: movement(i.arrival),
        },
      })),
    )
  }
  await db
    .update(flightSubscription)
    .set({ lastPushAt: now, ...(credits !== null ? { creditsRemaining: credits } : {}) })
    .where(eq(flightSubscription.id, sub.id))

  const result: PushResult = {
    ...empty,
    purpose: sub.purpose === 'test' ? 'test' : 'flight',
    stored: items.length,
    startedBy: sub.startedBy,
    credits,
  }

  if (sub.purpose === 'test') {
    let last = previous?.status ?? null
    for (const i of items) {
      if (i.status && i.status !== last) {
        const route = [i.departure?.airport?.iata, i.arrival?.airport?.iata].filter(Boolean).join(' to ')
        result.testLines.push(
          `${i.number ?? sub.flightNumber}${route ? ` (${route})` : ''}: ${i.status}${
            i.notificationSummary ? `. ${short(i.notificationSummary)}` : ''
          }`,
        )
        last = i.status
      }
    }
    result.testFinished = items.some((i) => isFinal(i.status))
    return result
  }

  const booked = await db.select().from(flight).where(eq(flight.pushSubscriptionId, sub.id))
  for (const f of booked) {
    const item = pickMatch(items, f)
    if (!item) continue
    const state = toLiveState(item, f)
    result.events += await applyState(db, f, state, now)
    if (state.status === 'landed' || state.status === 'cancelled') result.finished.push(f.id)
  }
  return result
}

/** The email address of whoever started a test. */
export async function starterEmail(db: Db, userId: string | null): Promise<{ email: string; name: string } | null> {
  if (!userId) return null
  const [u] = await db.select({ email: user.email, name: user.name }).from(user).where(eq(user.id, userId))
  return u ?? null
}
