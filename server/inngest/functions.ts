import { and, eq, gte, isNull, lte, or, notInArray } from 'drizzle-orm'
import { addDays, localDate, THEATRE_TZ } from '../../shared/time.js'
import { sendArrivalSummaries } from '../alerts/arrivals-summary.js'
import { sendFlightAlerts } from '../alerts/flight-alerts.js'
import { companyManagers, greeting } from '../alerts/recipients.js'
import { db } from '../db/client.js'
import { flight } from '../db/schema.js'
import { sendEmail } from '../email/send.js'
import { appOrigin } from '../env.js'
import type { AdbNotification } from '../flights/aerodatabox.js'
import { autoTopUp, topUpSettings } from '../flights/credits.js'
import { flightProvider, pushFeedOn, simulatedProvider } from '../flights/provider.js'
import {
  adbFromEnv,
  applyPush,
  endSubscription,
  LOW_CREDITS,
  releaseFlight,
  releaseIfUnused,
  starterEmail,
  TEST_HOURS,
  watchFlight,
} from '../flights/push.js'
import { feedNow } from '../flights/track.js'
import { inngest } from './client.js'

// Nothing here polls. Booked flights are watched only from 3 hours before
// take-off until they land (AeroDataBox pushes the changes), and the alert
// email goes out when a change is logged. The schedules left are the 6 PM
// "arriving tomorrow" email (with the catch-up) and the 7 AM credit check.

/** 6 PM theatre time, for the next day's arrivals. */
export const SUMMARY_CRON = 'TZ=America/New_York 0 18 * * *'

const HOUR = 3_600_000
/** Start watching this long before take-off. */
export const WATCH_BEFORE_MS = 3 * HOUR
/** Stop watching this long after the latest known arrival, if no landing ever arrives. */
export const FALLBACK_AFTER_MS = 6 * HOUR
/** Sleeps are split so none is longer than the Inngest plan allows. */
const MAX_SLEEP_MS = 6 * 24 * HOUR

interface Sleeper {
  sleepUntil: (id: string, time: Date) => Promise<unknown>
}

/** Sleeps until `target`, in pieces no longer than six days, counting from `from` so replays take the same steps. */
export async function sleepInPieces(step: Sleeper, id: string, from: number, target: Date): Promise<void> {
  let cursor = from
  let i = 0
  while (target.getTime() - cursor > MAX_SLEEP_MS) {
    cursor += MAX_SLEEP_MS
    await step.sleepUntil(`${id}-${i++}`, new Date(cursor))
  }
  await step.sleepUntil(`${id}-${i}`, target)
}

function api() {
  const client = adbFromEnv()
  if (!client) throw new Error('AERODATABOX_API_KEY is not set')
  return client
}

const finished = (status: string | null) => status === 'landed' || status === 'cancelled'

/**
 * One run per booked flight (started when it's saved). Sleeps until 3 hours
 * before take-off, joins or creates the subscription for its number, then
 * sleeps past the arrival as a fallback and lets go. A landing or
 * cancellation lets go sooner (apply-flight-push). Saving the flight again
 * replaces this run; removing it cancels it (release-removed-flight lets go).
 */
export const watchFlightJob = inngest.createFunction(
  {
    id: 'watch-flight',
    name: 'Watch a booked flight',
    triggers: { event: 'app/flight.saved' },
    cancelOn: [
      { event: 'app/flight.saved', match: 'data.flightId' },
      { event: 'app/flight.removed', match: 'data.flightId' },
    ],
  },
  async ({ event, step }) => {
    const flightId = String(event.data.flightId)
    const plan = await step.run('plan', async () => {
      if (!pushFeedOn()) return null
      // Saved again, maybe as another flight: let go of any earlier watch first.
      await releaseFlight(db(), api(), flightId)
      const [f] = await db().select().from(flight).where(eq(flight.id, flightId))
      if (!f || finished(f.liveStatus)) return null
      return {
        watchFrom: f.scheduledDeparture.getTime() - WATCH_BEFORE_MS,
        until: f.scheduledArrival.getTime() + FALLBACK_AFTER_MS,
      }
    })
    if (!plan) return { watched: false }

    await sleepInPieces(step, 'until-take-off', event.ts ?? plan.watchFrom, new Date(plan.watchFrom))
    // Make sure there are credits first, or AeroDataBox would send this flight
    // nothing. Waits for the top-up job (one at a time, so the monthly cap
    // holds); if it fails or takes too long, watch anyway.
    try {
      await step.invoke('credits-check', { function: topUpCreditsJob, data: {}, timeout: '5m' })
    } catch (error) {
      console.error('Credit check before watching a flight did not finish', error)
    }
    const subscriptionId = await step.run('subscribe', () => watchFlight(db(), api(), flightId, appOrigin()))
    if (!subscriptionId) return { watched: false }

    // Fallback: if no landing arrives, stop a while after the arrival. A late
    // flight moves that point out, up to three times.
    let until = plan.until
    for (let round = 0; ; round++) {
      await sleepInPieces(step, `fallback-${round}`, plan.watchFrom, new Date(until))
      if (round === 3) break
      const later = await step.run(`check-${round}`, async () => {
        const [f] = await db().select().from(flight).where(eq(flight.id, flightId))
        if (!f?.pushSubscriptionId || finished(f.liveStatus)) return null
        const next = (f.liveArrival ?? f.scheduledArrival).getTime() + FALLBACK_AFTER_MS
        return next > until ? next : null
      })
      if (!later) break
      until = later
    }
    await step.run('release', () => releaseFlight(db(), api(), flightId))
    return { watched: true }
  },
)

/** How far ahead the daily catch-up looks for flights nobody is watching yet. */
export const CATCH_UP_AHEAD_MS = 48 * HOUR

/**
 * Starts a watch for upcoming flights that never got one: flights saved
 * before the real feed was turned on, or whose save couldn't reach Inngest.
 * Runs daily at 6 PM, and on demand with the app/flights.catch-up event (send
 * it once after turning the real feed on). A flight that already has a watch
 * waiting just gets a fresh one in its place.
 */
export const catchUpFlightsJob = inngest.createFunction(
  {
    id: 'catch-up-flights',
    name: 'Watch upcoming flights that have no watch yet',
    triggers: [{ cron: SUMMARY_CRON }, { event: 'app/flights.catch-up' }],
    concurrency: 1,
  },
  async ({ step }) => {
    const ids = await step.run('find', async () => {
      if (!pushFeedOn()) return []
      const now = Date.now()
      const rows = await db()
        .select({ id: flight.id })
        .from(flight)
        .where(
          and(
            isNull(flight.pushSubscriptionId),
            // Still to come, or in the air now.
            gte(flight.scheduledArrival, new Date(now - FALLBACK_AFTER_MS)),
            lte(flight.scheduledDeparture, new Date(now + CATCH_UP_AHEAD_MS)),
            or(isNull(flight.liveStatus), notInArray(flight.liveStatus, ['landed', 'cancelled'])),
          ),
        )
      return rows.map((r) => r.id)
    })
    if (ids.length) {
      const day = localDate(new Date(), THEATRE_TZ)
      await step.sendEvent(
        'watch',
        // The id keeps a second run the same day from restarting the same watches.
        ids.map((flightId) => ({ id: `catch-up-${flightId}-${day}`, name: 'app/flight.saved', data: { flightId } })),
      )
    }
    return { queued: ids.length }
  },
)

/** A removed flight: end its subscription if no other flight uses it. */
export const releaseRemovedFlightJob = inngest.createFunction(
  { id: 'release-removed-flight', name: 'Stop watching a removed flight', triggers: { event: 'app/flight.removed' } },
  async ({ event, step }) => {
    const subscriptionId = event.data.subscriptionId ? String(event.data.subscriptionId) : null
    if (!subscriptionId) return { released: false }
    return { released: await step.run('release', () => releaseIfUnused(db(), api(), subscriptionId)) }
  },
)

/**
 * One push from AeroDataBox (handed over by /api/flight-push). Applies it,
 * emails what changed, stops watching flights that landed or were cancelled,
 * and warns when credits run low.
 */
export const applyFlightPushJob = inngest.createFunction(
  {
    id: 'apply-flight-push',
    name: 'Apply a flight update from AeroDataBox',
    triggers: { event: 'aerodatabox/push' },
    concurrency: { key: 'event.data.subscriptionId', limit: 1 },
  },
  async ({ event, step }) => {
    const subscriptionId = String(event.data.subscriptionId)
    const payload = (event.data.payload ?? {}) as AdbNotification
    const result = await step.run('apply', () => applyPush(db(), subscriptionId, payload, new Date()))

    if (result.events) {
      await step.run('email-alerts', () =>
        sendFlightAlerts(db(), { now: new Date(), origin: appOrigin(), simulated: false }),
      )
    }
    for (const flightId of result.finished) {
      await step.run(`release-${flightId}`, () => releaseFlight(db(), api(), flightId))
    }
    if (result.testLines.length) {
      await step.run('email-test', async () => {
        const to = await starterEmail(db(), result.startedBy)
        if (!to) return null
        const text = [
          greeting(to.name),
          '',
          'Your flight test got an update from AeroDataBox:',
          '',
          ...result.testLines.map((l) => `- ${l}`),
          '',
          `Arrivals board: ${appOrigin()}/arrivals`,
          '',
          'Flight data: AeroDataBox. This is a test of live flight alerts.',
        ].join('\n')
        return (await sendEmail({ to: to.email, subject: 'Flight test update', text }, { isDemo: false })).delivery
      })
    }
    if (result.testFinished) {
      await step.run('end-test', () => endSubscription(db(), api(), subscriptionId))
    }
    if (result.credits !== null && result.credits < Math.max(topUpSettings().below, LOW_CREDITS)) {
      // Top up if allowed; that job warns if the balance stays low.
      await step.sendEvent('credits-check', { name: CREDITS_CHECK, data: {} })
    }
    return { stored: result.stored, events: result.events, finished: result.finished.length }
  },
)

/** Ask the top-up job to check the balance. */
export const CREDITS_CHECK = 'app/credits.check'
/** 7 AM theatre time: the daily balance check. */
export const CREDITS_CRON = 'TZ=America/New_York 0 7 * * *'

/**
 * Keeps AeroDataBox's alert credits from running out: below the threshold it
 * adds credits, up to the monthly cap (see server/flights/credits.ts). Runs
 * daily, before a booked flight is watched, when a staff test starts, and
 * when an update shows the balance is low. One at a time, so the cap holds.
 * If the balance is still low afterwards (cap reached, or top-up off or
 * refused), the Company Managers get the low-credit warning.
 */
export const topUpCreditsJob = inngest.createFunction(
  {
    id: 'top-up-credits',
    name: 'Top up flight alert credits',
    triggers: [{ cron: CREDITS_CRON }, { event: CREDITS_CHECK }],
    concurrency: 1,
  },
  async ({ step }) => {
    const result = await step.run('top-up', async () => {
      const client = adbFromEnv()
      if (!client) return null
      try {
        return await autoTopUp(db(), client, new Date())
      } catch (error) {
        console.error('Automatic credit top-up failed', error)
        // Still warn below if the balance is low.
        return { action: 'failed' as const, credits: await client.balance().catch(() => null) }
      }
    })
    if (result && result.credits !== null && result.credits < LOW_CREDITS) {
      // The event id makes this at most one warning a day.
      await step.sendEvent('credits-low', {
        id: `credits-low-${localDate(new Date(), THEATRE_TZ)}`,
        name: 'app/credits.low',
        data: { credits: result.credits },
      })
    }
    return result
  },
)

/** Tells the Company Managers the AeroDataBox balance is running out. */
export const lowCreditsJob = inngest.createFunction(
  { id: 'warn-low-credits', name: 'Warn when flight alert credits run low', triggers: { event: 'app/credits.low' } },
  async ({ event, step }) => {
    const credits = Number(event.data.credits)
    return step.run('email', async () => {
      const recipients = await companyManagers(db(), 'travel_logistics')
      for (const r of recipients) {
        const text = [
          greeting(r.name),
          '',
          `Live flight alerts have ${credits} credits left. Each flight update costs one credit. When they run out, AeroDataBox stops sending updates until the balance is topped up.`,
          '',
          `Automatic top-up couldn't add more this time: it may have reached its monthly limit, be turned off, or have been refused by AeroDataBox. You can add credits at the bottom of the Arrivals page: ${appOrigin()}/arrivals`,
          '',
          'Sent by the theatre app.',
        ].join('\n')
        await sendEmail({ to: r.email, subject: 'Flight alert credits are low', text }, { isDemo: false })
      }
      return { recipients: recipients.length }
    })
  },
)

/** A staff flight test ends after a few hours even if the flight never lands. */
export const endFlightTestJob = inngest.createFunction(
  { id: 'end-flight-test', name: 'End a flight test', triggers: { event: 'app/flight-test.started' } },
  async ({ event, step }) => {
    const subscriptionId = String(event.data.subscriptionId)
    await step.sleep('test-window', `${TEST_HOURS}h`)
    return { ended: await step.run('end', () => endSubscription(db(), api(), subscriptionId)) }
  },
)

/**
 * Emails the Company Manager what the board just logged with the simulated
 * feed. The board sends the event when it logs a change (no polling); the
 * real feed emails from apply-flight-push instead.
 */
export const flightAlertsJob = inngest.createFunction(
  {
    id: 'email-flight-alerts',
    name: 'Email flight alerts',
    triggers: { event: 'app/flights.changed' },
    concurrency: 1,
  },
  async ({ step }) => {
    return step.run('email-alerts', async () => {
      const provider = flightProvider()
      return sendFlightAlerts(db(), {
        now: await feedNow(db(), provider),
        origin: appOrigin(),
        simulated: provider === simulatedProvider,
      })
    })
  },
)

/**
 * The "arriving tomorrow" email, one per production. Tomorrow is the feed's
 * tomorrow, so moving the demo clock to a travel day makes the summary follow.
 */
export const arrivalSummaryJob = inngest.createFunction(
  { id: 'arriving-tomorrow', name: 'Email who arrives tomorrow', triggers: { cron: SUMMARY_CRON }, concurrency: 1 },
  async ({ step }) => {
    return step.run('email-summaries', async () => {
      const now = await feedNow(db(), flightProvider())
      return sendArrivalSummaries(db(), { date: addDays(localDate(now, THEATRE_TZ), 1), origin: appOrigin() })
    })
  },
)

export const functions = [
  watchFlightJob,
  catchUpFlightsJob,
  releaseRemovedFlightJob,
  applyFlightPushJob,
  lowCreditsJob,
  topUpCreditsJob,
  endFlightTestJob,
  flightAlertsJob,
  arrivalSummaryJob,
]
