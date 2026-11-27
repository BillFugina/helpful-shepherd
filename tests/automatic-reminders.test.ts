import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb, type Db } from '../server/db/client.js'
import {
  auditEvent,
  contract,
  contractTemplate,
  engagement,
  person,
  production,
  reminderSettings,
  season,
  uploadLink,
  user,
  userRole,
} from '../server/db/schema.js'
import { REMINDER_RECORD } from '../server/documents/reminders.js'
import { resetEnvForTests } from '../server/env.js'
import { reminderFunctions } from '../server/inngest/reminders.js'
import {
  digestEmail,
  hasNews,
  loadDigest,
  sendDailyDigest,
  visibleTo,
  type DigestContent,
} from '../server/reminders/digest.js'
import { remindProduction } from '../server/reminders/paperwork.js'
import {
  contractDigestDay,
  contractLateOn,
  digestAt,
  nextDigestDay,
  paperworkReminderAt,
} from '../server/reminders/schedule.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import { GUEST_EMAIL, GUEST_USER_ID, type Grants, type Role } from '../shared/access.js'

const createCaller = createCallerFactory(appRouter)
const url = process.env.DATABASE_URL

describe('when automatic reminders are due', () => {
  // Nov 27 2026, 10 AM in Raleigh (EST, UTC-5).
  const now = new Date('2026-11-27T15:00:00Z')

  it('paperwork goes at 9 AM theatre time, the set number of days before first rehearsal', () => {
    // Jan 4 2027 rehearsal, 14 days before is Dec 21, 9 AM EST = 14:00 UTC.
    expect(paperworkReminderAt('2027-01-04', 14, now)?.toISOString()).toBe('2026-12-21T14:00:00.000Z')
    // Summer time: Jun 15 rehearsal, 10 days before is Jun 5, 9 AM EDT = 13:00 UTC.
    expect(paperworkReminderAt('2027-06-15', 10, now)?.toISOString()).toBe('2027-06-05T13:00:00.000Z')
  })

  it('if the reminder day has passed, the next 9 AM, but never on or after first rehearsal', () => {
    // Rehearsal Dec 5, 14 days before was Nov 21: next 9 AM is tomorrow.
    expect(paperworkReminderAt('2026-12-05', 14, now)?.toISOString()).toBe('2026-11-28T14:00:00.000Z')
    // Before 9 AM, that's this morning.
    expect(paperworkReminderAt('2026-12-05', 14, new Date('2026-11-27T12:00:00Z'))?.toISOString()).toBe(
      '2026-11-27T14:00:00.000Z',
    )
    // Rehearsal tomorrow: tomorrow 9 AM is the rehearsal day itself, so none.
    expect(paperworkReminderAt('2026-11-28', 14, now)).toBeNull()
    expect(paperworkReminderAt('2026-11-27', 14, now)).toBeNull()
  })

  it('no reminder when it is off or there is no rehearsal date', () => {
    expect(paperworkReminderAt('2027-01-04', 0, now)).toBeNull()
    expect(paperworkReminderAt(null, 14, now)).toBeNull()
  })

  it('the digest goes at 7 AM: today before then, otherwise tomorrow', () => {
    expect(digestAt('2026-11-28').toISOString()).toBe('2026-11-28T12:00:00.000Z')
    expect(nextDigestDay(now)).toBe('2026-11-28')
    expect(nextDigestDay(new Date('2026-11-27T11:00:00Z'))).toBe('2026-11-27')
  })

  it('a contract turns late the set number of days after it was sent, and lands in that morning’s digest', () => {
    expect(contractLateOn('2026-11-20', 7)).toBe('2026-11-27')
    expect(contractLateOn('2026-11-20', 0)).toBeNull()
    expect(contractDigestDay('2026-11-25', 7, now)).toBe('2026-12-02')
    // Marked sent with an old date: already late, so the next digest.
    expect(contractDigestDay('2026-11-01', 7, now)).toBe('2026-11-28')
    expect(contractDigestDay('2026-11-25', 0, now)).toBeNull()
  })

  it('no reminder job polls: every one starts from an event, none from a schedule', () => {
    expect(reminderFunctions).toHaveLength(3)
    for (const fn of reminderFunctions) {
      const triggers = (fn as unknown as { opts: { triggers: unknown } }).opts.triggers
      const list = (Array.isArray(triggers) ? triggers : [triggers]) as Record<string, unknown>[]
      expect(list.length).toBeGreaterThan(0)
      for (const t of list) {
        expect(t.cron).toBeUndefined()
        expect(typeof t.event).toBe('string')
      }
    }
  })
})

describe('the digest email', () => {
  const content: DigestContent = {
    reminders: [{ production: 'Into the Woods', name: 'Riley', text: 'emailed for W-4' }],
    received: [{ production: 'Into the Woods', name: 'Sam', text: 'I-9' }],
    sentBack: [],
    unsigned: [{ production: 'Hamlet', name: 'Jo', text: 'sent Nov 1, 26 days ago', news: false }],
    contractDays: 7,
  }

  it('lists each section with names, and links back to the app', () => {
    const { subject, text } = digestEmail(content, { name: 'Ash Allen', origin: 'https://app.test', day: '2026-11-28' })
    expect(subject).toBe('Theatre digest for Saturday, November 28')
    expect(text).toContain('Hi Ash,')
    expect(text).toContain('- Riley, Into the Woods: emailed for W-4')
    expect(text).toContain('Contracts still unsigned after 7 days')
    expect(text).not.toContain('Forms Finance sent back')
    expect(text).toContain('https://app.test/settings/reminders')
  })

  it('a contract that was already late is not news on its own', () => {
    expect(hasNews({ ...content, reminders: [], received: [] })).toBe(false)
    expect(
      hasNews({ ...content, reminders: [], received: [], unsigned: [{ ...content.unsigned[0]!, news: true }] }),
    ).toBe(true)
  })

  it('shows paperwork only to roles that see documents, and contracts only to roles that see contracts', () => {
    const docsOnly: Grants = { general: 'view', documents: 'view' }
    const mine = visibleTo(content, docsOnly)
    expect(mine.reminders).toHaveLength(1)
    expect(mine.unsigned).toHaveLength(0)
    expect(visibleTo(content, { documents: 'view' }).reminders).toHaveLength(0)
  })
})

describe.skipIf(!url)('automatic reminders against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const tag = randomUUID().slice(0, 8)
  const cm: SessionUser = {
    id: `test-${randomUUID()}`,
    email: `cm-${tag}@example.com`,
    name: 'Sam CM',
    twoFactorEnabled: true,
  }
  const finance: SessionUser = {
    id: `test-${randomUUID()}`,
    email: `fin-${tag}@example.com`,
    name: 'Finance',
    twoFactorEnabled: true,
  }
  const guest: SessionUser = { id: GUEST_USER_ID, email: GUEST_EMAIL, name: 'Demo guest', twoFactorEnabled: false }
  const asCm = () => createCaller({ db, user: cm })
  const realAddress = `riley-${tag}@real-test.org`
  const people: string[] = []
  let seasonId = ''
  let heldProduction = ''
  let liveProduction = ''
  let avery = ''
  let riley = ''
  let templateId = ''
  const start = new Date()

  async function addUser(u: SessionUser, role: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  async function addPerson(productionId: string, legalName: string, email?: string) {
    const r = await asCm().engagements.quickCreate({
      productionId,
      person: { kind: 'new', person: { legalName, ...(email ? { email } : {}) } },
      agent: { kind: 'none' },
      terms: { role: 'Ensemble', contractType: 'sdc', weeklyPayCents: 90000 },
      conflicts: [],
    })
    people.push(r.personId)
    return r.id
  }

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(finance, 'finance_manager')
    seasonId = (
      await asCm().seasons.create({
        name: `Auto reminders ${tag}`,
        program: 'main_stage',
        startsOn: '2031-01-01',
        endsOn: '2031-12-31',
      })
    ).id
    heldProduction = (
      await asCm().productions.create({ seasonId, title: `Held play ${tag}`, rehearsalStart: '2031-02-01' })
    ).id
    liveProduction = (
      await asCm().productions.create({ seasonId, title: `Live play ${tag}`, rehearsalStart: '2031-03-01' })
    ).id
    avery = await addPerson(heldProduction, `Avery Auto ${tag}`, `avery-${tag}@example.com`)
    await addPerson(heldProduction, `Blake NoEmail ${tag}`)
    riley = await addPerson(liveProduction, `Riley Real ${tag}`, realAddress)
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    const prods = db.select({ id: production.id }).from(production).where(eq(production.seasonId, seasonId))
    const engs = db.select({ id: engagement.id }).from(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(uploadLink).where(inArray(uploadLink.engagementId, engs))
    await db.delete(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(production).where(eq(production.seasonId, seasonId))
    if (templateId) await db.delete(contractTemplate).where(eq(contractTemplate.id, templateId))
    await db.delete(season).where(eq(season.id, seasonId))
    if (people.length) await db.delete(person).where(inArray(person.id, people))
    await db.delete(user).where(inArray(user.id, [cm.id, finance.id]))
    await db.delete(reminderSettings)
  })

  it('with email off, logs what would have gone, makes no link, and never repeats', async () => {
    const first = await remindProduction(db, heldProduction)
    expect(first).toMatchObject({ checked: 2, sent: 0, held: 1, skipped: 1 })
    const [log] = await db
      .select({ detail: auditEvent.detail, actorId: auditEvent.actorId })
      .from(auditEvent)
      .where(and(eq(auditEvent.recordType, REMINDER_RECORD), eq(auditEvent.recordId, avery)))
    expect(log?.actorId).toBeNull()
    expect(log?.detail).toMatchObject({ auto: true, rehearsalStart: '2031-02-01', delivery: 'logged' })
    expect(JSON.stringify(log?.detail)).not.toContain('@')
    expect(await db.select().from(uploadLink).where(eq(uploadLink.engagementId, avery))).toHaveLength(0)
    // Restarted or retried: nobody is reminded twice for the same first rehearsal.
    expect(await remindProduction(db, heldProduction)).toMatchObject({ held: 0, skipped: 2 })
  })

  it('with email on, sends the reminder with a fresh upload link, once', async () => {
    const calls: { to: string[]; text: string; reply_to?: string }[] = []
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)))
      return new Response('{"id":"1"}', { status: 200 })
    })
    const saved = { ...process.env }
    Object.assign(process.env, {
      RESEND_API_KEY: 're_test',
      EMAIL_FROM: 'Theatre <r@real-test.org>',
      EMAIL_DELIVERY: 'allowlist',
      EMAIL_ALLOWLIST: realAddress,
    })
    resetEnvForTests()
    try {
      expect(await remindProduction(db, liveProduction)).toMatchObject({ sent: 1 })
      expect(await remindProduction(db, liveProduction)).toMatchObject({ sent: 0, skipped: 1 })
    } finally {
      for (const k of ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_DELIVERY', 'EMAIL_ALLOWLIST']) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      resetEnvForTests()
      vi.unstubAllGlobals()
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]!.to).toEqual([realAddress])
    expect(calls[0]!.text).toMatch(/\/upload\/[A-Za-z0-9_-]{43}/)
    const links = await db.select().from(uploadLink).where(eq(uploadLink.engagementId, riley))
    expect(links).toHaveLength(1)
    expect(links[0]!.createdBy).toBeNull()
  })

  it('the morning digest reports the automatic reminders, once a day', async () => {
    const content = await loadDigest(db, new Date(start.getTime() - 1000), new Date(), 7)
    const names = content.reminders.map((r) => r.name)
    expect(names).toContain(`Avery Auto ${tag}`)
    expect(names).toContain(`Riley Real ${tag}`)
    expect(hasNews(content)).toBe(true)

    // The audit log is append-only, so each run uses a day no other run has used.
    const day = `${2100 + (parseInt(tag, 16) % 7000)}-01-15`
    const outcome = await sendDailyDigest(db, { day, now: new Date(), origin: 'https://app.test' })
    expect(outcome.status).toBe('sent')
    expect(await sendDailyDigest(db, { day, now: new Date(), origin: 'https://app.test' })).toEqual({
      status: 'already_sent',
    })
  })

  it('the digest can be turned off', async () => {
    await asCm().reminders.save({ paperworkDaysBefore: 14, contractDaysAfter: 7, digestOn: false })
    expect(await sendDailyDigest(db, { day: '2031-02-28', now: new Date(), origin: 'https://app.test' })).toEqual({
      status: 'off',
    })
    await asCm().reminders.save({ paperworkDaysBefore: 14, contractDaysAfter: 7, digestOn: true })
  })

  it('a new contract threshold reports contracts that turned late under it, once', async () => {
    const t = await asCm().contracts.templates.saveText({
      name: `Auto rider ${tag}`,
      contractType: 'sdc',
      body: '# Rider\n{{employee.name}}',
    })
    templateId = t.id
    const [tpl] = await db.select().from(contractTemplate).where(eq(contractTemplate.id, t.id))
    // Sent long ago and never signed: already late under any threshold.
    await db.insert(contract).values({
      engagementId: avery,
      templateId: t.id,
      templateFamilyId: tpl!.familyId,
      status: 'sent',
      sentOn: '2026-01-05',
      sentAt: new Date('2026-01-05T15:00:00Z'),
      sentTo: 'them',
    })
    const mine = (c: Awaited<ReturnType<typeof loadDigest>>) => c.unsigned.find((u) => u.name === `Avery Auto ${tag}`)
    const before = new Date()
    expect(mine(await loadDigest(db, new Date(before.getTime() - 1), new Date(), 7))?.news).toBe(false)
    await asCm().reminders.save({ paperworkDaysBefore: 14, contractDaysAfter: 3, digestOn: true })
    expect(mine(await loadDigest(db, new Date(before.getTime() - 1), new Date(), 3))?.news).toBe(true)
    // The same save again changes nothing, so it isn't news again.
    const after = new Date()
    await asCm().reminders.save({ paperworkDaysBefore: 14, contractDaysAfter: 3, digestOn: true })
    expect(mine(await loadDigest(db, after, new Date(), 3))?.news).toBe(false)
  })

  it('shows what is coming up, worked out from the dates', async () => {
    await asCm().reminders.save({ paperworkDaysBefore: 10, contractDaysAfter: 5, digestOn: true })
    const { settings, productions } = await asCm().reminders.upcoming()
    expect(settings.paperworkDaysBefore).toBe(10)
    const held = productions.find((p) => p.id === heldProduction)!
    // Jan 22 2031, 9 AM EST.
    expect(held.reminderAt?.toISOString()).toBe('2031-01-22T14:00:00.000Z')
    expect(held.missing.find((m) => m.engagementId === avery)?.reminded).toBe('logged')
  })

  it('only the Company Manager changes the settings or sends a preview, never the guest or Finance', async () => {
    const input = { paperworkDaysBefore: 14, contractDaysAfter: 7, digestOn: true }
    for (const u of [guest, finance]) {
      await expect(createCaller({ db, user: u }).reminders.save(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(createCaller({ db, user: u }).reminders.sendDigestNow()).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    }
    await expect(asCm().reminders.save({ ...input, paperworkDaysBefore: 120 })).rejects.toBeTruthy()
    const preview = await asCm().reminders.sendDigestNow()
    // Email is off in tests: the preview comes back to read on screen.
    expect(preview.delivery).toBe('logged')
    expect(preview.text).toContain('Here’s a preview of your morning digest')
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditEvent)
      .where(and(eq(auditEvent.recordType, 'digest_preview'), eq(auditEvent.actorId, cm.id)))
    expect(row?.n).toBe(1)
  })
})
