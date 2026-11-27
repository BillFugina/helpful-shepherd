import { inngest, inngestEnabled } from '../inngest/client.js'
import { contractDigestDay, nextDigestDay } from './schedule.js'
import { loadReminderSettings } from './settings.js'
import type { Db } from '../db/client.js'

// Tells Inngest about changes that set when a reminder is due, after the
// database write has committed. Best effort: a failure is logged and never
// fails the save. Event data is ids and dates only.

export const PAPERWORK_PLAN = 'app/paperwork.plan'
export const DIGEST_WAKE = 'app/digest.wake'
export const REMINDERS_REPLAN = 'app/reminders.replan'

type Outgoing = { id?: string; name: string; data: Record<string, unknown> }

async function send(events: Outgoing[]): Promise<void> {
  if (!inngestEnabled() || !events.length) return
  try {
    await inngest.send(events)
  } catch (error) {
    console.error('could not tell Inngest about a reminder change', error)
  }
}

/** Event for a digest on this day. The id folds repeats for the same day together. */
export const digestWake = (day: string): Outgoing => ({ id: `digest-${day}`, name: DIGEST_WAKE, data: { day } })

/** A production's first rehearsal, or who's on it, changed: (re)plan its paperwork reminder. */
export async function paperworkChanged(productionIds: readonly string[]): Promise<void> {
  await send([...new Set(productionIds)].map((productionId) => ({ name: PAPERWORK_PLAN, data: { productionId } })))
}

/** A contract went out: make sure there's a digest the morning it would turn late. */
export async function contractSent(db: Db, sentOn: string, now = new Date()): Promise<void> {
  if (!inngestEnabled()) return
  let day: string | null
  try {
    // Best effort like the rest of this file: the contract has already gone out.
    const { contractDaysAfter } = await loadReminderSettings(db)
    day = contractDigestDay(sentOn, contractDaysAfter, now)
  } catch (error) {
    console.error('could not read reminder settings to book a contract digest', error)
    return
  }
  if (day) await send([digestWake(day)])
}

/** A form came in by link, or Finance sent one back: it goes in the next morning's digest. */
export async function formsNews(now = new Date()): Promise<void> {
  await send([digestWake(nextDigestDay(now))])
}

/** Settings changed: plan every reminder again with the new numbers. */
export async function remindersReplan(): Promise<void> {
  await send([{ name: REMINDERS_REPLAN, data: {} }])
}
