import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptField, fieldKey } from '../server/crypto/fields.js'
import { createDb, type Db } from '../server/db/client.js'
import { auditEvent, person, rateLimit, session } from '../server/db/schema.js'
import { ensureGuestUser, guestDemoClosed } from '../server/demo/guest.js'
import { replayFlight } from '../server/flights/replay.js'
import { simulateStatus } from '../server/flights/provider.js'
import { resetEnvForTests } from '../server/env.js'
import { createContext, handleAuth } from '../server/handlers.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import { GUEST_EMAIL, GUEST_GRANTS, GUEST_USER_ID, NEVER_FOR_GUEST } from '../shared/access.js'

const createCaller = createCallerFactory(appRouter)
const noDb = new Proxy({} as Db, {
  get() {
    throw new Error('this test should not touch the database')
  },
})
const guest: SessionUser = { id: GUEST_USER_ID, email: GUEST_EMAIL, name: 'Demo guest', twoFactorEnabled: false }

describe('guest demo, without a database', () => {
  it('the guest never gets the sensitive groups', () => {
    for (const group of NEVER_FOR_GUEST) expect(GUEST_GRANTS[group]).toBeUndefined()
    for (const level of Object.values(GUEST_GRANTS)) expect(level).toBe('view')
  })

  it('me says guest, with view-only grants and no two-factor', async () => {
    const me = await createCaller({ db: noDb, user: guest }).me()
    expect(me).toMatchObject({ role: 'guest', guest: true, grants: GUEST_GRANTS })
  })

  it('every change is refused before it reaches the database', async () => {
    const caller = createCaller({ db: noDb, user: guest })
    await expect(caller.people.create({ legalName: 'Nope' } as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'DEMO_READ_ONLY',
    })
    await expect(caller.people.reveal({ personId: randomUUID(), field: 'dob' })).rejects.toMatchObject({
      message: 'DEMO_READ_ONLY',
    })
    await expect(caller.arrivals.resetClock()).rejects.toMatchObject({
      message: 'DEMO_READ_ONLY',
    })
  })

  it('the guest gets nothing through the connector', async () => {
    const caller = createCaller({ db: noDb, user: guest, via: 'connector' })
    await expect(caller.people.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('replaying the flight feed for a guest clock', () => {
  const row = {
    id: randomUUID(),
    engagementId: randomUUID(),
    direction: 'arrival' as const,
    airline: 'DL',
    flightNumber: '2007',
    fromAirport: 'LGA',
    toAirport: 'RDU',
    scheduledDeparture: new Date('2027-01-10T14:00:00Z'),
    scheduledArrival: new Date('2027-01-10T15:45:00Z'),
    confirmation: null,
    bookingSource: null,
    notes: null,
    liveStatus: null,
    liveDeparture: null,
    liveArrival: null,
    liveGate: null,
    liveTerminal: null,
    liveBaggage: null,
    liveCheckedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it('has nothing to show more than a day before departure', () => {
    const r = replayFlight(row, new Date('2027-01-09T12:00:00Z'))
    expect(r.live.liveStatus).toBeNull()
    expect(r.events).toEqual([])
  })

  it('matches the feed at that moment, and logs the delay once', () => {
    const now = new Date('2027-01-10T13:00:00Z')
    const r = replayFlight(row, now)
    expect(r.live.liveStatus).toBe(simulateStatus(row, now).status)
    expect(r.live.liveStatus).toBe('delayed')
    expect(r.live.liveCheckedAt?.toISOString()).toBe(now.toISOString())
    expect(r.events.filter((e) => e.kind === 'delayed')).toHaveLength(1)
  })

  it('stops checking once the flight has landed', () => {
    const r = replayFlight(row, new Date('2027-01-11T12:00:00Z'))
    expect(r.live.liveStatus).toBe('landed')
    const last = r.events.at(-1)!
    expect(last.at.getTime()).toBeLessThanOrEqual(new Date('2027-01-10T16:40:00Z').getTime())
  })
})

const url = process.env.DATABASE_URL
describe.skipIf(!url)('guest demo against Postgres', () => {
  const db = url ? createDb(url) : noDb
  const origin = 'http://localhost:5173'
  let personId = ''

  function post(path: string, body: unknown, cookie = '') {
    return handleAuth(
      new Request(`${origin}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie },
        body: JSON.stringify(body),
      }),
    )
  }
  function cookieFrom(res: Response) {
    return res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
  }
  const contextFor = (cookie: string) => createContext(new Request(`${origin}/api/trpc/me`, { headers: { cookie } }))

  beforeAll(async () => {
    process.env.BETTER_AUTH_URL = origin
    await db.delete(rateLimit)
    await ensureDefaultGrants(db)
    await ensureGuestUser(db)
    const key = fieldKey()
    const [p] = await db
      .insert(person)
      .values({
        legalName: `Guest Test ${randomUUID()}`,
        email: 'guest.test@example.com',
        isDemo: true,
        dobEnc: encryptField('1990-01-02', 'person.dob', key),
        tsaKtnEnc: encryptField('TT8888888', 'person.tsa_ktn', key),
      })
      .returning({ id: person.id })
    personId = p!.id
  })

  afterAll(async () => {
    await db.delete(person).where(eq(person.id, personId))
    await db.delete(session).where(eq(session.userId, GUEST_USER_ID))
    await db.delete(rateLimit)
  })

  it('the guest reads people without two-factor, with the sensitive groups gone', async () => {
    const rows = await createCaller({ db, user: guest }).people.list()
    const row = rows.find((p) => p.id === personId)
    expect(row?.email).toBe('guest.test@example.com')
    expect(row && 'dob' in row).toBe(false)
    expect(row && 'tsaKtn' in row).toBe(false)
    expect(JSON.stringify(rows)).not.toContain('TT8888888')
  })

  it('admin screens stay closed to the guest', async () => {
    const caller = createCaller({ db, user: guest })
    await expect(caller.audit.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.access.matrix()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('Try the demo signs in with no password, for two hours, and logs no sign-in', async () => {
    const res = await post('/demo/guest', {})
    expect(res.ok).toBe(true)
    const { expiresAt } = (await res.json()) as { expiresAt: string }
    const hours = (new Date(expiresAt).getTime() - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(1.9)
    expect(hours).toBeLessThanOrEqual(2)

    const ctx = await contextFor(cookieFrom(res))
    expect(ctx.user?.id).toBe(GUEST_USER_ID)
    const signIns = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.actorId, GUEST_USER_ID), eq(auditEvent.action, 'sign_in')))
    expect(signIns).toEqual([])
  })

  it("the shared guest session can't list or revoke sessions, or change the account", async () => {
    const cookie = cookieFrom(await post('/demo/guest', {}))
    const list = await handleAuth(new Request(`${origin}/api/auth/list-sessions`, { headers: { origin, cookie } }))
    expect(list.status).toBe(403)
    expect((await post('/revoke-sessions', {}, cookie)).status).toBe(403)
    expect((await post('/update-user', { name: 'Hacked' }, cookie)).status).toBe(403)
    expect((await post('/two-factor/enable', { password: 'x' }, cookie)).status).toBe(403)
    const live = await db.select().from(session).where(eq(session.userId, GUEST_USER_ID))
    expect(live.length).toBeGreaterThanOrEqual(2)
  })

  it('a guest session older than two hours counts as signed out', async () => {
    const cookie = cookieFrom(await post('/demo/guest', {}))
    const old = new Date(Date.now() - 3 * 3_600_000)
    const ids = (await db.select({ id: session.id }).from(session).where(eq(session.userId, GUEST_USER_ID))).map(
      (s) => s.id,
    )
    await db.update(session).set({ createdAt: old }).where(inArray(session.id, ids))
    expect((await contextFor(cookie)).user).toBeNull()
  })

  it('a real record closes the demo, for sign-in and for open guest sessions', async () => {
    await db.delete(rateLimit)
    const cookie = cookieFrom(await post('/demo/guest', {}))
    const [real] = await db
      .insert(person)
      .values({ legalName: `Real Person ${randomUUID()}`, email: 'real.person@example.com' })
      .returning({ id: person.id })
    try {
      expect(await guestDemoClosed(db)).toBe('real_data')
      const ctx = await contextFor(cookie)
      await expect(createCaller(ctx).people.list()).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'DEMO_CLOSED' })
      expect((await post('/demo/guest', {})).status).toBe(503)
    } finally {
      await db.delete(person).where(eq(person.id, real!.id))
    }
    expect(await guestDemoClosed(db)).toBeNull()
    expect(await createCaller({ db, user: guest }).people.list()).not.toHaveLength(0)
  })

  it('DEMO_GUEST=off closes open guest sessions too', async () => {
    await db.delete(rateLimit)
    const cookie = cookieFrom(await post('/demo/guest', {}))
    const before = process.env.DEMO_GUEST
    process.env.DEMO_GUEST = 'off'
    resetEnvForTests()
    try {
      const ctx = await contextFor(cookie)
      await expect(createCaller(ctx).people.list()).rejects.toMatchObject({ message: 'DEMO_CLOSED' })
      expect((await post('/demo/guest', {})).status).toBe(404)
    } finally {
      if (before === undefined) delete process.env.DEMO_GUEST
      else process.env.DEMO_GUEST = before
      resetEnvForTests()
    }
  })

  it('rate-limits Try the demo per visitor', async () => {
    await db.delete(rateLimit)
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) statuses.push((await post('/demo/guest', {})).status)
    expect(statuses).toContain(429)
  })
})
