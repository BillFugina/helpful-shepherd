import { and, eq, gt } from 'drizzle-orm'
import { localDate, THEATRE_TZ } from '../../shared/time.js'
import { db } from '../db/client.js'
import { contract, production } from '../db/schema.js'
import { appOrigin } from '../env.js'
import { digestWake, DIGEST_WAKE, PAPERWORK_PLAN, REMINDERS_REPLAN } from '../reminders/announce.js'
import { digestSentFor, sendDailyDigest } from '../reminders/digest.js'
import { remindProduction } from '../reminders/paperwork.js'
import { contractLateOn, digestAt, nextDigestDay, paperworkReminderAt } from '../reminders/schedule.js'
import { loadReminderSettings } from '../reminders/settings.js'
import { inngest } from './client.js'
import { sleepInPieces } from './functions.js'

// Automatic reminders. Nothing here polls or scans on a timer. Each reminder
// is one run that sleeps until its moment, started by the change that set it:
//
// - Paperwork: one run per production, started when its first rehearsal date
//   is set or changed, when someone is added to it, or when the settings
//   change. A newer plan for the same production replaces the sleeping run.
//   When it wakes it looks again, so forms that came in meanwhile are not
//   asked for.
// - Unsigned contracts: marking a contract sent books a digest for the
//   morning it would turn late. If it's signed by then, it isn't mentioned.
// - The digest: one run per morning that has something to report, booked by
//   the things above (and by forms coming in or being sent back). Quiet
//   mornings get no run and no email.

const DAY = /^\d{4}-\d{2}-\d{2}$/
/** A digest whose morning passed longer ago than this is dropped, not sent late. */
const DIGEST_GRACE_MS = 6 * 3_600_000

export const paperworkReminderJob = inngest.createFunction(
  {
    id: 'paperwork-reminder',
    name: 'Remind people of missing forms before first rehearsal',
    triggers: { event: PAPERWORK_PLAN },
    cancelOn: [{ event: PAPERWORK_PLAN, match: 'data.productionId' }],
    concurrency: { key: 'event.data.productionId', limit: 1 },
  },
  async ({ event, step }) => {
    const productionId = String(event.data.productionId)
    const at = await step.run('plan', async () => {
      const [prod] = await db()
        .select({ rehearsalStart: production.rehearsalStart })
        .from(production)
        .where(eq(production.id, productionId))
        .limit(1)
      const { paperworkDaysBefore } = await loadReminderSettings(db())
      return paperworkReminderAt(prod?.rehearsalStart ?? null, paperworkDaysBefore, new Date())?.getTime() ?? null
    })
    if (at === null) return { planned: false }
    await sleepInPieces(step, 'until-reminder-day', event.ts ?? Date.now(), new Date(at))
    const result = await step.run('remind', async () => {
      // Settings may have changed while asleep; if it's off now, do nothing.
      const { paperworkDaysBefore } = await loadReminderSettings(db())
      if (paperworkDaysBefore <= 0) return null
      return remindProduction(db(), productionId, new Date())
    })
    if (result && result.sent + result.held + result.failed > 0) {
      await step.sendEvent('digest', digestWake(localDate(new Date(at + 86_400_000), THEATRE_TZ)))
    }
    return result
  },
)

export const dailyDigestJob = inngest.createFunction(
  {
    id: 'daily-digest',
    name: 'Email the Company Manager’s morning digest',
    triggers: { event: DIGEST_WAKE },
    // One run per morning: another booking for a morning already waiting is dropped.
    singleton: { key: 'event.data.day', mode: 'skip' },
  },
  async ({ event, step }) => {
    const day = String(event.data.day)
    if (!DAY.test(day)) return { status: 'bad_day' }
    const at = digestAt(day).getTime()
    const go = await step.run('plan', async () => {
      if (at < Date.now() - DIGEST_GRACE_MS) return false
      return !(await digestSentFor(db(), day))
    })
    if (!go) return { status: 'skipped' }
    await sleepInPieces(step, 'until-morning', event.ts ?? Date.now(), new Date(at))
    return step.run('email', () => sendDailyDigest(db(), { day, now: new Date(), origin: appOrigin() }))
  },
)

/**
 * Plans every reminder again: after the settings change, and once after this
 * feature is first deployed (saving the settings sends it).
 */
export const replanRemindersJob = inngest.createFunction(
  {
    id: 'replan-reminders',
    name: 'Plan automatic reminders again',
    triggers: { event: REMINDERS_REPLAN },
    concurrency: 1,
  },
  async ({ step }) => {
    const plan = await step.run('find', async () => {
      const now = new Date()
      const today = localDate(now, THEATRE_TZ)
      const settings = await loadReminderSettings(db())
      const prods = await db()
        .select({ id: production.id })
        .from(production)
        .where(gt(production.rehearsalStart, today))
      const days = new Set<string>()
      if (settings.contractDaysAfter > 0) {
        const sent = await db()
          .select({ sentOn: contract.sentOn })
          .from(contract)
          .where(and(eq(contract.status, 'sent')))
        for (const c of sent) {
          const late = c.sentOn ? contractLateOn(c.sentOn, settings.contractDaysAfter) : null
          if (!late) continue
          // Turns late later: that morning's digest. Already late (a first save
          // or a lower threshold): the next digest, which lists it as new.
          days.add(digestAt(late).getTime() > now.getTime() ? late : nextDigestDay(now))
        }
      }
      return { productionIds: prods.map((p) => p.id), days: [...days] }
    })
    const events = [
      ...plan.productionIds.map((productionId) => ({ name: PAPERWORK_PLAN, data: { productionId } })),
      ...plan.days.map(digestWake),
    ]
    if (events.length) await step.sendEvent('plan', events)
    return { productions: plan.productionIds.length, digests: plan.days.length }
  },
)

export const reminderFunctions = [paperworkReminderJob, dailyDigestJob, replanRemindersJob]
