import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { flight, flightPush, flightSubscription, user } from '../db/schema.js'
import {
  adbClient,
  bestTime,
  canonNumber,
  effectiveStatus,
  happenedAt,
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

/** Running tests, then recent ones, newest first, with what each received. Flight data only. */
export async function listTests(db: Db) {
  const subs = await db
    .select()
    .from(flightSubscription)
    .where(eq(flightSubscription.purpose, 'test'))
    // Running tests first, so each keeps its Stop button however many ended since.
    .orderBy(desc(flightSubscription.active), desc(flightSubscription.createdAt))
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

const THEATRE_TZ = 'America/New_York'
const clock = (d: Date) =>
  `${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: THEATRE_TZ })} ET`

/** "18 min late" or "6 min early" against the schedule; nothing within 5 minutes. */
function lateness(actual: Date | null, scheduled: Date | null): string {
  if (!actual || !scheduled) return ''
  const min = Math.round((actual.getTime() - scheduled.getTime()) / 60_000)
  if (Math.abs(min) < 5) return ''
  return min > 0 ? ` (${min} min late)` : ` (${-min} min early)`
}

/** One leg of a flight in a pushed update. The same number can fly several legs a day. */
const legKey = (i: { number: string; from: string | null; to: string | null; scheduled: Date | null }) =>
  [canonNumber(i.number), i.from ?? '', i.to ?? '', i.scheduled?.toISOString() ?? ''].join('|')

/**
 * A pushed flight as one line a person can read: where it is, its times in
 * theatre time, how late it is, and the arrival gate and bag belt when known.
 */
export function describeLeg(i: AdbFlightItem, status: string, now: Date, fallbackNumber: string): string {
  const number = short(i.number, 20) ?? fallbackNumber
  const route = [i.departure?.airport?.iata, i.arrival?.airport?.iata].filter(Boolean).join(' to ')
  const scheduledArrival = parseUtc(i.arrival?.scheduledTime?.utc)
  const departure = happenedAt(i.departure, now) ?? bestTime(i.departure)
  // Only a runway time that has passed is a takeoff; anything else is an estimate.
  const runway = parseUtc(i.departure?.runwayTime?.utc)
  const tookOff = runway && runway.getTime() <= now.getTime() ? runway : null
  const arrival = bestTime(i.arrival)
  let what: string
  switch (status) {
    case 'Canceled':
    case 'CanceledUncertain':
      what = 'cancelled'
      break
    case 'Diverted':
      what = 'diverted'
      break
    case 'Arrived': {
      const landed = happenedAt(i.arrival, now) ?? arrival
      what = landed ? `landed ${clock(landed)}${lateness(landed, scheduledArrival)}` : 'landed'
      break
    }
    case 'Departed':
    case 'EnRoute':
    case 'Approaching':
      what = [
        tookOff ? `took off ${clock(tookOff)}` : 'in the air',
        arrival ? `landing about ${clock(arrival)}${lateness(arrival, scheduledArrival)}` : null,
      ]
        .filter(Boolean)
        .join(', ')
      break
    default:
      what = [
        status === 'Delayed' ? 'delayed' : null,
        departure ? `leaves ${clock(departure)}` : null,
        arrival ? `lands ${clock(arrival)}${lateness(arrival, scheduledArrival)}` : null,
      ]
        .filter(Boolean)
        .join(', ')
      if (!what) what = 'no times yet'
  }
  const gate = short(i.arrival?.gate, 10)
  const belt = status === 'Arrived' ? short(i.arrival?.baggageBelt, 10) : null
  const extras = [gate ? `arrival gate ${gate}` : null, belt ? `bags at belt ${belt}` : null].filter(Boolean)
  const summary = short(i.notificationSummary)
  return `${number}${route ? ` ${route}` : ''}: ${what}${extras.length ? `, ${extras.join(', ')}` : ''}${
    summary ? `. ${summary}` : ''
  }`
}

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

  // What each leg looked like in the last update, to tell what changed.
  const earlier = await db
    .select()
    .from(flightPush)
    .where(eq(flightPush.subscriptionId, sub.id))
    .orderBy(desc(flightPush.receivedAt))
    .limit(50)
  const lastSeen = new Map<string, { status: string; expectedArrival: number | null }>()
  for (const p of earlier) {
    const key = legKey({ number: p.number, from: p.fromAirport, to: p.toAirport, scheduled: p.scheduledDeparture })
    if (lastSeen.has(key)) continue
    const expected = typeof p.detail?.expectedArrival === 'string' ? parseUtc(p.detail.expectedArrival) : null
    lastSeen.set(key, { status: p.status, expectedArrival: expected?.getTime() ?? null })
  }
  const rows = items.map((i) => ({
    item: i,
    status: effectiveStatus(i, now),
    expectedArrival: bestTime(i.arrival),
    row: {
      subscriptionId: sub.id,
      receivedAt: now,
      number: short(i.number, 20) ?? '?',
      status: short(effectiveStatus(i, now), 40) ?? 'Expected',
      fromAirport: short(i.departure?.airport?.iata, 4),
      toAirport: short(i.arrival?.airport?.iata, 4),
      scheduledDeparture: parseUtc(i.departure?.scheduledTime?.utc),
    },
  }))
  if (rows.length) {
    await db.insert(flightPush).values(
      rows.map(({ item: i, expectedArrival, row }) => ({
        ...row,
        detail: {
          summary: short(i.notificationSummary),
          remark: short(i.notificationRemark),
          rawStatus: short(i.status, 40),
          expectedArrival: expectedArrival?.toISOString() ?? null,
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
    // A line for each leg that is new, changed status, or moved its arrival by 5 minutes or more.
    for (const { item: i, status, expectedArrival, row } of rows) {
      const key = legKey({
        number: row.number,
        from: row.fromAirport,
        to: row.toAirport,
        scheduled: row.scheduledDeparture,
      })
      const before = lastSeen.get(key)
      const moved =
        !!before &&
        before.expectedArrival !== null &&
        expectedArrival !== null &&
        Math.abs(before.expectedArrival - expectedArrival.getTime()) >= 5 * 60_000
      if (!before || before.status !== status || moved) {
        result.testLines.push(describeLeg(i, status, now, sub.flightNumber))
      }
      lastSeen.set(key, { status, expectedArrival: expectedArrival?.getTime() ?? null })
    }
    result.testFinished = rows.some((r) => isFinal(r.status))
    return result
  }

  const booked = await db.select().from(flight).where(eq(flight.pushSubscriptionId, sub.id))
  for (const f of booked) {
    const item = pickMatch(items, f)
    if (!item) continue
    const state = toLiveState(item, f, now)
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
