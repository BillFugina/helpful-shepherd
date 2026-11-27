import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { generateVAPIDKeys } from 'web-push'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flightAlertPush, type AlertItem } from '../server/alerts/flight-alerts.js'
import { createDb, type Db } from '../server/db/client.js'
import { auditEvent, pushSubscription, user, userRole } from '../server/db/schema.js'
import { env, resetEnvForTests, type Env } from '../server/env.js'
import {
  isPushEndpoint,
  MAX_FAILURES,
  pushDecision,
  pushMode,
  pushPayload,
  pushToCompanyManagers,
  pushToUser,
  type PushSender,
} from '../server/push/send.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import { GUEST_EMAIL, GUEST_USER_ID, type Role } from '../shared/access.js'

const createCaller = createCallerFactory(appRouter)
const keys = generateVAPIDKeys()
const base = { DATABASE_URL: 'x', BETTER_AUTH_SECRET: 'x'.repeat(32) } as Env
const on = (over: Partial<Env> = {}): Env => ({
  ...base,
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
  PUSH_DELIVERY: 'allowlist',
  PUSH_ALLOWLIST: 'sam@theatre.org',
  BETTER_AUTH_URL: 'https://app.theatre.org',
  ...over,
})

const item = (over: Partial<AlertItem> = {}): AlertItem => ({
  kind: 'delayed',
  detail: { minutes: 45 },
  name: 'Avery',
  production: 'The Play',
  airline: 'B6',
  flightNumber: '1017',
  direction: 'arrival',
  fromAirport: 'BOS',
  toAirport: 'RDU',
  scheduledDeparture: new Date('2033-02-01T14:00:00Z'),
  scheduledArrival: new Date('2033-02-01T16:10:00Z'),
  liveDeparture: new Date('2033-02-01T14:45:00Z'),
  liveArrival: new Date('2033-02-01T16:55:00Z'),
  ...over,
})

describe('phone alerts, without a database', () => {
  it('is off without both keys, and off unless PUSH_DELIVERY says otherwise', () => {
    expect(pushMode(base)).toBe('off')
    expect(pushMode({ ...base, PUSH_DELIVERY: 'live', VAPID_PUBLIC_KEY: keys.publicKey })).toBe('off')
    expect(pushMode(on({ PUSH_DELIVERY: undefined }))).toBe('off')
    expect(pushMode(on())).toBe('allowlist')
  })

  it('sends only to listed logins in allowlist mode, and never to demo logins', () => {
    expect(pushDecision('sam@theatre.org', on())).toBeNull()
    expect(pushDecision(' SAM@theatre.org ', on())).toBeNull()
    expect(pushDecision('ash@theatre.org', on())).toContain('test list')
    expect(pushDecision('ash@theatre.org', on({ PUSH_DELIVERY: 'live' }))).toBeNull()
    expect(
      pushDecision('company.manager@example.com', on({ PUSH_ALLOWLIST: 'company.manager@example.com' })),
    ).toContain('Demo logins')
    expect(pushDecision('company.manager@example.com', on({ PUSH_DELIVERY: 'live' }))).toContain('Demo logins')
    expect(pushDecision('sam@theatre.org', base)).toContain('turned off')
  })

  it('accepts only the browsers’ push services as endpoints', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
    expect(isPushEndpoint('https://web.push.apple.com/QK1')).toBe(true)
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true)
    expect(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true)
    expect(isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false)
    expect(isPushEndpoint('https://fcm.googleapis.com.evil.org/x')).toBe(false)
    expect(isPushEndpoint('https://evilpush.apple.com.org/x')).toBe(false)
    expect(isPushEndpoint('https://user:pw@fcm.googleapis.com/x')).toBe(false)
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false)
    expect(isPushEndpoint('https://localhost/x')).toBe(false)
    expect(isPushEndpoint('not a url')).toBe(false)
  })

  it('writes the Declarative Web Push shape, opening a page in this app only', () => {
    const json = JSON.parse(pushPayload({ title: 'T', body: 'B', path: '/arrivals' }, 'https://app.theatre.org'))
    expect(json).toEqual({
      web_push: 8030,
      notification: {
        title: 'T',
        body: 'B',
        navigate: 'https://app.theatre.org/arrivals',
        lang: 'en-US',
        dir: 'ltr',
        silent: false,
      },
    })
    const evil = JSON.parse(pushPayload({ title: 'T', body: 'B', path: '//evil.org/x' }, 'https://app.theatre.org'))
    expect(evil.notification.navigate).toBe('https://app.theatre.org/')
    const long = JSON.parse(pushPayload({ title: '', body: 'x'.repeat(5000), path: '/' }, 'https://app.theatre.org'))
    expect(long.notification.body.length).toBe(600)
    expect(long.notification.title).toBe('Theatre Raleigh')
  })

  it('says the same as the flight alert email, a few lines at most', () => {
    const one = flightAlertPush({ items: [item()], simulated: false })
    expect(one).toEqual({
      title: "Avery's flight is delayed",
      body: 'Avery (The Play), B6 1017 from BOS: late by 45 min, now lands at 11:55 AM.',
      path: '/arrivals',
    })
    const many = flightAlertPush({ items: Array.from({ length: 6 }, () => item()), simulated: true })
    expect(many.title).toBe('6 flight updates')
    const lines = many.body.split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[4]).toBe('And 2 more on the Arrivals board.')
    expect(lines[5]).toContain('Simulated')
  })
})

const url = process.env.DATABASE_URL
describe.skipIf(!url)('phone alerts against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const tag = randomUUID().slice(0, 8)
  const mk = (name: string, domain = `push-${tag}.org`): SessionUser => ({
    id: `test-${randomUUID()}`,
    email: `${name}@${domain}`,
    name,
    twoFactorEnabled: true,
  })
  const cm = mk('sam')
  const cm2 = mk('ash')
  const finance = mk('fin')
  const demoCm = mk('demo', 'example.com')
  const users = [cm, cm2, finance, demoCm]
  const guest: SessionUser = { id: GUEST_USER_ID, email: GUEST_EMAIL, name: 'Guest', twoFactorEnabled: false }
  const as = (u: SessionUser) => createCaller({ db, user: u })
  const sub = (n: string) => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${tag}-${n}`,
    keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
  })
  const saved: Record<string, string | undefined> = {}
  const envKeys = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'PUSH_DELIVERY', 'PUSH_ALLOWLIST'] as const

  async function addUser(u: SessionUser, role: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  beforeAll(async () => {
    for (const k of envKeys) saved[k] = process.env[k]
    process.env.VAPID_PUBLIC_KEY = keys.publicKey
    process.env.VAPID_PRIVATE_KEY = keys.privateKey
    // No PUSH_DELIVERY: off, so nothing here can reach a real push service.
    delete process.env.PUSH_DELIVERY
    delete process.env.PUSH_ALLOWLIST
    resetEnvForTests()
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(cm2, 'company_manager')
    await addUser(finance, 'finance_manager')
    await addUser(demoCm, 'company_manager')
  })

  afterAll(async () => {
    const ids = users.map((u) => u.id)
    await db.delete(pushSubscription).where(inArray(pushSubscription.userId, ids))
    await db.delete(userRole).where(inArray(userRole.userId, ids))
    await db.delete(user).where(inArray(user.id, ids))
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    resetEnvForTests()
  })

  it('lets the Company Manager turn alerts on, and nobody else', async () => {
    const { id } = await as(cm).push.subscribe({ ...sub('1'), deviceLabel: 'iPhone' })
    expect(id).toBeTruthy()
    await expect(as(finance).push.subscribe({ ...sub('f'), deviceLabel: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(as(demoCm).push.subscribe({ ...sub('d'), deviceLabel: 'x' })).rejects.toThrow('Demo logins')
    await expect(as(guest).push.subscribe({ ...sub('g'), deviceLabel: 'x' })).rejects.toMatchObject({
      message: 'DEMO_READ_ONLY',
    })
    await expect(
      as(cm).push.subscribe({ ...sub('1'), endpoint: 'https://example.org/push', deviceLabel: 'x' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const audit = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.recordType, 'push_subscription'), eq(auditEvent.actorId, cm.id)))
    expect(audit.some((a) => a.action === 'create')).toBe(true)
  })

  it('shows this login’s devices, marks this one, and never sends the endpoints back', async () => {
    const status = await as(cm).push.status({ endpoint: sub('1').endpoint })
    expect(status.canTurnOn).toBe(true)
    expect(status.publicKey).toBe(keys.publicKey)
    expect(status.held).toContain('turned off')
    expect(status.devices).toHaveLength(1)
    expect(status.devices[0]).toMatchObject({ deviceLabel: 'iPhone', thisDevice: true })
    expect(JSON.stringify(status)).not.toContain('fcm.googleapis.com')
    expect((await as(cm2).push.status({})).devices).toHaveLength(0)
    const fin = await as(finance).push.status({})
    expect(fin).toMatchObject({ canTurnOn: false, publicKey: null })
    expect((await as(guest).push.status({})).canTurnOn).toBe(false)
  })

  it('refresh only updates a device this login already has', async () => {
    const changed = { ...sub('1b') }
    expect((await as(cm2).push.refresh({ ...changed, previousEndpoint: sub('1').endpoint })).on).toBe(false)
    expect((await as(cm).push.refresh({ ...changed, previousEndpoint: sub('1').endpoint })).on).toBe(true)
    const rows = await db.select().from(pushSubscription).where(eq(pushSubscription.userId, cm.id))
    expect(rows.map((r) => r.endpoint)).toEqual([changed.endpoint])
    expect((await as(cm2).push.refresh(sub('never'))).on).toBe(false)
  })

  it('a test alert is held while delivery is off, without calling a push service', async () => {
    expect(await as(cm).push.test()).toEqual({ sent: 0, held: 1, removed: 0, failed: 0 })
  })

  it('sends to allowlisted logins, drops gone devices, and gives up on one that keeps failing', async () => {
    await db.delete(pushSubscription).where(eq(pushSubscription.userId, cm.id))
    await as(cm).push.subscribe({ ...sub('ok'), deviceLabel: 'Mac (Chrome)' })
    await as(cm).push.subscribe({ ...sub('gone'), deviceLabel: 'Old phone' })
    await as(cm).push.subscribe({ ...sub('flaky'), deviceLabel: 'Tablet' })
    const sent: { endpoint: string; payload: string }[] = []
    const send: PushSender = async (s, payload) => {
      if (s.endpoint.endsWith('-gone')) throw Object.assign(new Error('gone'), { statusCode: 410 })
      if (s.endpoint.endsWith('-flaky')) throw Object.assign(new Error('busy'), { statusCode: 503 })
      sent.push({ endpoint: s.endpoint, payload })
      return { statusCode: 201, body: '', headers: {} }
    }
    const e = { ...env(), PUSH_DELIVERY: 'allowlist' as const, PUSH_ALLOWLIST: cm.email }
    const notice = { title: 'Hi', body: 'There', path: '/arrivals' }

    expect(await pushToUser(db, cm2.id, notice, { send, env: e })).toEqual({ sent: 0, held: 0, removed: 0, failed: 0 })
    const first = await pushToUser(db, cm.id, notice, { send, env: e })
    expect(first).toEqual({ sent: 1, held: 0, removed: 1, failed: 1 })
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!.payload).notification.title).toBe('Hi')
    for (let i = 1; i < MAX_FAILURES - 1; i++) await pushToUser(db, cm.id, notice, { send, env: e })
    const last = await pushToUser(db, cm.id, notice, { send, env: e })
    expect(last.removed).toBe(1)
    const left = await db.select().from(pushSubscription).where(eq(pushSubscription.userId, cm.id))
    expect(left.map((r) => r.deviceLabel)).toEqual(['Mac (Chrome)'])
    expect(left[0]!.lastSentAt).not.toBeNull()

    // Not on the list: held, nothing sent.
    await as(cm2).push.subscribe({ ...sub('ash'), deviceLabel: 'iPhone' })
    sent.length = 0
    expect(await pushToUser(db, cm2.id, notice, { send, env: e })).toMatchObject({ sent: 0, held: 1 })
    expect(sent).toHaveLength(0)
  })

  it('a demo login never gets a push, even listed and even with a device saved', async () => {
    await db
      .insert(pushSubscription)
      .values({ userId: demoCm.id, ...sub('demo').keys, endpoint: sub('demo').endpoint, deviceLabel: 'x' })
    let calls = 0
    const send: PushSender = async () => {
      calls++
      return { statusCode: 201, body: '', headers: {} }
    }
    const e = { ...env(), PUSH_DELIVERY: 'live' as const, PUSH_ALLOWLIST: demoCm.email }
    expect(await pushToUser(db, demoCm.id, { title: 'x', body: 'y', path: '/' }, { send, env: e })).toMatchObject({
      sent: 0,
      held: 1,
    })
    expect(await pushToUser(db, GUEST_USER_ID, { title: 'x', body: 'y', path: '/' }, { send, env: e })).toMatchObject({
      sent: 0,
      held: 0,
    })
    expect(calls).toBe(0)
  })

  it('flight alerts go to Company Managers’ devices only, with counts in the audit log', async () => {
    await db
      .insert(pushSubscription)
      .values({ userId: finance.id, ...sub('fin').keys, endpoint: sub('fin').endpoint, deviceLabel: 'x' })
    const reached: string[] = []
    const send: PushSender = async (s) => {
      reached.push(s.endpoint)
      return { statusCode: 201, body: '', headers: {} }
    }
    const e = { ...env(), PUSH_DELIVERY: 'live' as const }
    const total = await pushToCompanyManagers(db, { title: 'x', body: 'y', path: '/arrivals' }, { send, env: e })
    expect(reached).toContain(sub('ok').endpoint)
    expect(reached).toContain(sub('ash').endpoint)
    expect(reached).not.toContain(sub('fin').endpoint)
    expect(reached).not.toContain(sub('demo').endpoint)
    expect(total.sent).toBeGreaterThanOrEqual(2)
  })

  it('turning off and removing only touch this login’s devices', async () => {
    expect((await as(cm2).push.unsubscribe({ endpoint: sub('ok').endpoint })).removed).toBe(0)
    const [ashRow] = await db.select().from(pushSubscription).where(eq(pushSubscription.userId, cm2.id))
    expect((await as(cm).push.remove({ id: ashRow!.id })).removed).toBe(0)
    expect((await as(cm2).push.remove({ id: ashRow!.id })).removed).toBe(1)
    expect((await as(cm).push.unsubscribe({ endpoint: sub('ok').endpoint })).removed).toBe(1)
    expect(await db.select().from(pushSubscription).where(eq(pushSubscription.userId, cm.id))).toHaveLength(0)
  })

  it('a device that changes hands moves to the login that turned it on', async () => {
    await as(cm).push.subscribe({ ...sub('shared'), deviceLabel: 'iPad' })
    await as(cm2).push.subscribe({ ...sub('shared'), deviceLabel: 'iPad' })
    const rows = await db
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.endpoint, sub('shared').endpoint))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.userId).toBe(cm2.id)
  })
})
