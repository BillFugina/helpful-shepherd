import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import { formsToRemind } from '../../shared/documents.js'
import { reminderSettingsInput } from '../../shared/reminders.js'
import { localDate, THEATRE_TZ } from '../../shared/time.js'
import { sees } from '../alerts/recipients.js'
import { recordAudit } from '../audit.js'
import { auditEvent, contract, engagement, person, production, reminderSettings } from '../db/schema.js'
import { REMINDER_RECORD } from '../documents/reminders.js'
import { loadChecklists } from '../documents/service.js'
import { deliveryMode, sendEmail } from '../email/send.js'
import { appOrigin } from '../env.js'
import { remindersReplan } from '../reminders/announce.js'
import { digestEmail, loadDigest, MAX_LOOKBACK_MS, visibleTo } from '../reminders/digest.js'
import { contractLateOn, paperworkReminderAt } from '../reminders/schedule.js'
import { loadReminderSettings } from '../reminders/settings.js'
import { adminProcedure, router, staffProcedure } from '../trpc.js'
import { requireView } from '../writes.js'

const nameOf = (r: { preferredName: string | null; legalName: string }) => r.preferredName?.trim() || r.legalName

export const remindersRouter = router({
  settings: staffProcedure.query(async ({ ctx }) => {
    requireView(ctx.grants, 'documents')
    return { ...(await loadReminderSettings(ctx.db)), mode: deliveryMode() }
  }),

  /** Saves the settings and plans every reminder again with them. */
  save: adminProcedure.input(reminderSettingsInput).mutation(async ({ ctx, input }) => {
    await ctx.db
      .insert(reminderSettings)
      .values({ id: 1, ...input })
      .onConflictDoUpdate({ target: reminderSettings.id, set: { ...input, updatedAt: new Date() } })
    await recordAudit(ctx.db, {
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'update',
      recordType: 'reminder_settings',
      recordId: '1',
      fieldGroup: 'documents',
      detail: { fields: Object.keys(input) },
    })
    await remindersReplan()
    return { ok: true }
  }),

  /**
   * What's coming: each production's paperwork reminder and who it would go
   * to today, and contracts that are out. Worked out from the dates, the
   * same way the sleeping runs work it out.
   */
  upcoming: staffProcedure.query(async ({ ctx }) => {
    requireView(ctx.grants, 'general')
    const now = new Date()
    const today = localDate(now, THEATRE_TZ)
    const settings = await loadReminderSettings(ctx.db)
    const showDocs = sees(ctx.grants, 'documents')
    const showContracts = sees(ctx.grants, 'contracts')

    const prods = showDocs
      ? await ctx.db
          .select({ id: production.id, title: production.title, rehearsalStart: production.rehearsalStart })
          .from(production)
          .where(gte(production.rehearsalStart, today))
          .orderBy(asc(production.rehearsalStart), asc(production.title))
      : []
    const engs = prods.length
      ? await ctx.db
          .select({
            id: engagement.id,
            productionId: engagement.productionId,
            contractType: engagement.contractType,
            legalName: person.legalName,
            preferredName: person.preferredName,
          })
          .from(engagement)
          .innerJoin(person, eq(person.id, engagement.personId))
          .where(
            inArray(
              engagement.productionId,
              prods.map((p) => p.id),
            ),
          )
          .orderBy(asc(person.legalName))
      : []
    const checklists = await loadChecklists(ctx.db, engs)
    const autoRows = engs.length
      ? await ctx.db
          .select({ recordId: auditEvent.recordId, detail: auditEvent.detail })
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.recordType, REMINDER_RECORD),
              inArray(
                auditEvent.recordId,
                engs.map((e) => e.id),
              ),
              sql`${auditEvent.detail}->>'auto' = 'true'`,
            ),
          )
      : []
    const productions = prods.map((p) => {
      const at = paperworkReminderAt(p.rehearsalStart, settings.paperworkDaysBefore, now)
      const missing = engs
        .filter((e) => e.productionId === p.id)
        .map((e) => {
          const auto = autoRows.find(
            (r) =>
              r.recordId === e.id && r.detail?.rehearsalStart === p.rehearsalStart && r.detail?.delivery !== 'failed',
          )
          return {
            engagementId: e.id,
            name: nameOf(e),
            forms: formsToRemind(checklists.get(e.id) ?? []),
            reminded: auto ? String(auto.detail?.delivery ?? 'logged') : null,
          }
        })
        .filter((m) => m.forms.length)
      return { id: p.id, title: p.title, rehearsalStart: p.rehearsalStart!, reminderAt: at, missing }
    })

    const contracts =
      showContracts && settings.contractDaysAfter > 0
        ? (
            await ctx.db
              .select({
                id: contract.id,
                sentOn: contract.sentOn,
                legalName: person.legalName,
                preferredName: person.preferredName,
                title: production.title,
              })
              .from(contract)
              .innerJoin(engagement, eq(engagement.id, contract.engagementId))
              .innerJoin(person, eq(person.id, engagement.personId))
              .innerJoin(production, eq(production.id, engagement.productionId))
              .where(eq(contract.status, 'sent'))
              .orderBy(asc(contract.sentOn))
          ).map((c) => {
            const lateOn = contractLateOn(c.sentOn!, settings.contractDaysAfter)!
            return { id: c.id, name: nameOf(c), production: c.title, sentOn: c.sentOn!, lateOn, late: lateOn <= today }
          })
        : []
    return { settings, productions, contracts }
  }),

  /**
   * Emails the signed-in Company Manager a preview of the digest, covering
   * the last 7 days whether or not anything is new. Goes through the same
   * email rules as everything else (test list, reserved addresses).
   */
  sendDigestNow: adminProcedure.mutation(async ({ ctx }) => {
    requireView(ctx.grants, 'documents')
    const now = new Date()
    const settings = await loadReminderSettings(ctx.db)
    const content = visibleTo(
      await loadDigest(ctx.db, new Date(now.getTime() - MAX_LOOKBACK_MS), now, settings.contractDaysAfter),
      ctx.grants,
    )
    const email = digestEmail(content, {
      name: ctx.user.name,
      origin: appOrigin(),
      day: localDate(now, THEATRE_TZ),
      preview: true,
    })
    const result = await sendEmail({ to: ctx.user.email, ...email }, { isDemo: false })
    await recordAudit(ctx.db, {
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'send',
      recordType: 'digest_preview',
      fieldGroup: 'documents',
      detail: { delivery: result.delivery },
    })
    return { ...result, ...(result.delivery === 'sent' ? {} : { text: email.text }) }
  }),
})
