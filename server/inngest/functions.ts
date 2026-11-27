import { addDays, localDate, THEATRE_TZ } from '../../shared/time.js'
import { sendArrivalSummaries } from '../alerts/arrivals-summary.js'
import { sendFlightAlerts } from '../alerts/flight-alerts.js'
import { db } from '../db/client.js'
import { appOrigin } from '../env.js'
import { flightProvider } from '../flights/provider.js'
import { feedNow, trackFlights } from '../flights/track.js'
import { inngest } from './client.js'

/**
 * Every 15 minutes from 6 AM to 10:45 PM theatre time. Overnight it rests, so
 * the free-tier database can sleep; the board still checks flights whenever
 * someone opens it.
 */
export const TRACK_CRON = 'TZ=America/New_York */15 6-22 * * *'
/** 6 PM theatre time, for the next day's arrivals. */
export const SUMMARY_CRON = 'TZ=America/New_York 0 18 * * *'

/**
 * Asks the flight feed about flights in the air or due within the day (the
 * same tracker the board runs, through the same provider adapter and demo
 * clock), then emails the Company Manager what changed.
 */
export const trackFlightsJob = inngest.createFunction(
  { id: 'track-flights', name: 'Check flights and email alerts', triggers: { cron: TRACK_CRON }, concurrency: 1 },
  async ({ step }) => {
    const tracked = await step.run('check-flights', async () => {
      const provider = flightProvider()
      return trackFlights(db(), provider, await feedNow(db(), provider))
    })
    const alerted = await step.run('email-alerts', async () => {
      const provider = flightProvider()
      return sendFlightAlerts(db(), {
        now: await feedNow(db(), provider),
        origin: appOrigin(),
        simulated: provider.name === 'simulated',
      })
    })
    return { ...tracked, ...alerted }
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

export const functions = [trackFlightsJob, arrivalSummaryJob]
