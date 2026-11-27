import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../server/db/client.js'
import { auditEvent, engagement, person, production, season, uploadLink, user, userRole } from '../server/db/schema.js'
import { REMINDER_RECORD, reminderEmail } from '../server/documents/reminders.js'
import { deliveryDecision, deliveryMode, isReservedAddress, sendEmail } from '../server/email/send.js'
import type { Env } from '../server/env.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import { GUEST_EMAIL, GUEST_USER_ID, type Role } from '../shared/access.js'
import { buildChecklist, formsToRemind, type DocumentRow } from '../shared/documents.js'

const createCaller = createCallerFactory(appRouter)
const url = process.env.DATABASE_URL
const base = { DATABASE_URL: 'x', BETTER_AUTH_SECRET: 'x'.repeat(32) } as Env
const on = (extra: Partial<Env>): Env => ({ ...base, RESEND_API_KEY: 're_test', EMAIL_FROM: 'T <r@t.org>', ...extra })

describe('reminder email rules, without a database', () => {
  it('never sends without a key and a sender, or in log mode', () => {
    expect(deliveryMode(base)).toBe('log')
    expect(deliveryMode({ ...base, EMAIL_DELIVERY: 'live', RESEND_API_KEY: 're_test' })).toBe('log')
    expect(deliveryMode(on({}))).toBe('log')
    expect(deliveryDecision('a@real.org', { isDemo: false }, base)?.delivery).toBe('logged')
  })

  it('allowlist mode sends only to listed addresses', () => {
    const e = on({ EMAIL_DELIVERY: 'allowlist', EMAIL_ALLOWLIST: 'Bill@Real.org, ash@real.org' })
    expect(deliveryDecision('bill@real.org', { isDemo: true }, e)).toBeNull()
    expect(deliveryDecision('other@real.org', { isDemo: false }, e)?.delivery).toBe('held')
  })

  it('live mode sends to real people but never to demo people or reserved domains', () => {
    const e = on({ EMAIL_DELIVERY: 'live', EMAIL_ALLOWLIST: 'bill@real.org' })
    expect(deliveryDecision('someone@real.org', { isDemo: false }, e)).toBeNull()
    expect(deliveryDecision('someone@real.org', { isDemo: true }, e)?.delivery).toBe('held')
    expect(deliveryDecision('bill@real.org', { isDemo: true }, e)).toBeNull()
    expect(deliveryDecision('avery@example.com', { isDemo: false }, e)?.delivery).toBe('held')
    expect(isReservedAddress('x@mail.example.org')).toBe(true)
    expect(isReservedAddress('x@examples.com')).toBe(false)
  })

  it('sends through Resend only when allowed, with a one-line subject', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const fakeFetch = (async (u: string, init: RequestInit) => {
      calls.push({ url: u, body: JSON.parse(String(init.body)) })
      return new Response('{"id":"1"}', { status: 200 })
    }) as unknown as typeof fetch
    const e = on({ EMAIL_DELIVERY: 'allowlist', EMAIL_ALLOWLIST: 'bill@real.org' })
    const msg = { to: 'bill@real.org', subject: 'Forms\r\nBcc: x@y.z', text: 'hi', replyTo: 'cm@example.com' }
    expect(await sendEmail(msg, { isDemo: true }, { fetch: fakeFetch, env: e })).toEqual({ delivery: 'sent' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.resend.com/emails')
    expect(calls[0]!.body.subject).toBe('Forms Bcc: x@y.z')
    expect(calls[0]!.body.reply_to).toBeUndefined()
    const held = await sendEmail({ ...msg, to: 'no@real.org' }, { isDemo: false }, { fetch: fakeFetch, env: e })
    expect(held.delivery).toBe('held')
    expect(calls).toHaveLength(1)
  })

  it('asks for missing forms and ones Finance sent back, not ones waiting', () => {
    const row = (documentType: DocumentRow['documentType'], status: DocumentRow['status'], note?: string) =>
      ({
        id: randomUUID(),
        documentType,
        status,
        hasFile: false,
        receivedOn: null,
        receivedVia: null,
        sentToFinanceAt: null,
        acceptedAt: null,
        filePurgedAt: null,
        financeNote: note ?? null,
      }) satisfies DocumentRow
    const items = buildChecklist(
      ['w4', 'nc4', 'i9', 'direct_deposit'],
      [row('nc4', 'received'), row('i9', 'received', 'Unsigned'), row('direct_deposit', 'accepted')],
    )
    expect(formsToRemind(items)).toEqual(['w4', 'i9'])
  })

  it('writes an email that names the forms and carries the link', () => {
    const { subject, text } = reminderEmail({
      firstName: 'Avery',
      theatre: 'Demo Theatre',
      productionTitle: 'The Play',
      forms: ['w4', 'i9'],
      url: 'https://app.test/upload/abc',
      expiresAt: new Date('2031-01-15T12:00:00Z'),
      senderName: 'Sam',
    })
    expect(subject).toBe('Forms still needed for The Play')
    expect(text).toContain('Hi Avery,')
    expect(text).toContain('https://app.test/upload/abc')
    expect(text).toContain('January 15, 2031')
    expect(text).toMatch(/- W-4/)
  })
})

describe.skipIf(!url)('reminders against Postgres', () => {
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
  const people: string[] = []
  let seasonId = ''
  let productionId = ''
  let withEmail = ''
  let noEmail = ''

  async function addUser(u: SessionUser, role: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(finance, 'finance_manager')
    const s = await asCm().seasons.create({
      name: `Reminders ${tag}`,
      program: 'main_stage',
      startsOn: '2031-01-01',
      endsOn: '2031-12-31',
    })
    seasonId = s.id
    const p = await asCm().productions.create({
      seasonId,
      title: `Reminder play ${tag}`,
      rehearsalStart: '2031-02-01',
      opening: '2031-03-01',
      closing: '2031-03-20',
    })
    productionId = p.id
    const a = await asCm().engagements.quickCreate({
      productionId,
      person: {
        kind: 'new',
        person: { legalName: `Avery Actor ${tag}`, preferredName: 'Avery', email: `avery-${tag}@example.com` },
      },
      agent: { kind: 'none' },
      terms: { role: 'Lead', contractType: 'sdc', weeklyPayCents: 105000 },
      conflicts: [],
    })
    withEmail = a.id
    people.push(a.personId)
    const b = await asCm().engagements.quickCreate({
      productionId,
      person: { kind: 'new', person: { legalName: `Blake NoEmail ${tag}` } },
      agent: { kind: 'none' },
      terms: { role: 'Swing', contractType: 'sdc', weeklyPayCents: 90000 },
      conflicts: [],
    })
    noEmail = b.id
    people.push(b.personId)
  })

  afterAll(async () => {
    const prods = db.select({ id: production.id }).from(production).where(eq(production.seasonId, seasonId))
    await db.delete(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(production).where(eq(production.seasonId, seasonId))
    await db.delete(season).where(eq(season.id, seasonId))
    if (people.length) await db.delete(person).where(inArray(person.id, people))
    await db.delete(user).where(inArray(user.id, [cm.id, finance.id]))
  })

  it('only the Company Manager can send, never the guest, Finance or the connector', async () => {
    const input = { engagementIds: [withEmail] }
    await expect(createCaller({ db, user: guest }).documents.reminders.send(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(createCaller({ db, user: finance }).documents.reminders.send(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      createCaller({ db, user: cm, via: 'connector' }).documents.reminders.send(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('without email set up, makes a working link and hands back the email instead of sending', async () => {
    expect((await asCm().documents.reminders.status()).mode).toBe('log')
    const { results } = await asCm().documents.reminders.send({ engagementIds: [withEmail, noEmail] })
    const sent = results.find((r) => r.engagementId === withEmail)!
    expect(sent.outcome).toBe('logged')
    expect(sent.email?.to).toBe(`avery-${tag}@example.com`)
    expect(sent.email?.text).toContain('W-9')
    const token = sent.email!.text.match(/\/upload\/([A-Za-z0-9_-]+)/)![1]!
    const page = await createCaller({ db, user: null }).uploadLink.get({ token })
    expect(page.items.map((i) => i.documentType)).toEqual(['w9', 'direct_deposit', 'bank_verification'])
    expect(results.find((r) => r.engagementId === noEmail)).toMatchObject({
      outcome: 'skipped',
      reason: 'No email address on file.',
    })
    // The log says what was asked for, never the address or the link.
    const events = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.recordType, REMINDER_RECORD), eq(auditEvent.recordId, withEmail)))
    expect(events).toHaveLength(1)
    expect(events[0]!.detail).toMatchObject({
      delivery: 'logged',
      documentTypes: ['w9', 'direct_deposit', 'bank_verification'],
    })
    expect(JSON.stringify(events[0]!.detail)).not.toContain('@')
    expect(JSON.stringify(events[0]!.detail)).not.toContain(token)
    // An unsent reminder doesn't turn off earlier links.
    const links = await db.select().from(uploadLink).where(eq(uploadLink.engagementId, withEmail))
    expect(links.every((l) => l.revokedAt === null)).toBe(true)
  })

  it('the production page shows who can be reminded and when they last were', async () => {
    const o = await asCm().documents.overview({ productionId })
    const a = o.engagements.find((e) => e.id === withEmail)!
    const b = o.engagements.find((e) => e.id === noEmail)!
    expect(a.hasEmail).toBe(true)
    expect(a.toRemind).toEqual(['w9', 'direct_deposit', 'bank_verification'])
    expect(a.lastReminder?.delivery).toBe('logged')
    expect(b.hasEmail).toBe(false)
    expect(b.lastReminder).toBeNull()
    expect(JSON.stringify(o)).not.toContain(`avery-${tag}@example.com`)
  })
})
