import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../server/db/client.js'
import {
  engagement,
  flight,
  flightEvent,
  flightSubscription,
  person,
  production,
  season,
  user,
  userRole,
} from '../server/db/schema.js'
import {
  adbClient,
  canonNumber,
  hashToken,
  matchesFlight,
  newToken,
  parseUtc,
  pickMatch,
  subjectFor,
  toLiveState,
  type AdbClient,
  type AdbFlightItem,
} from '../server/flights/aerodatabox.js'
import type { FlightSpec } from '../server/flights/provider.js'
import { pushFeedOn } from '../server/flights/provider.js'
import {
  applyPush,
  endSubscription,
  listTests,
  MAX_TESTS,
  releaseFlight,
  startTest,
  watchFlight,
} from '../server/flights/push.js'
import { handleFlightPush } from '../server/flights/webhook.js'
import { sleepInPieces } from '../server/inngest/functions.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'

const createCaller = createCallerFactory(appRouter)

const spec: FlightSpec = {
  direction: 'arrival',
  airline: 'B6',
  flightNumber: '1017',
  fromAirport: 'BOS',
  toAirport: 'RDU',
  scheduledDeparture: new Date('2033-02-01T14:00:00Z'),
  scheduledArrival: new Date('2033-02-01T16:10:00Z'),
}

const pushed = (over: Partial<AdbFlightItem> = {}): AdbFlightItem => ({
  number: 'B6 1017',
  status: 'Expected',
  lastUpdatedUtc: '2033-02-01 12:00Z',
  departure: { airport: { iata: 'BOS' }, scheduledTime: { utc: '2033-02-01 14:00Z' } },
  arrival: { airport: { iata: 'RDU' }, scheduledTime: { utc: '2033-02-01 16:10Z' }, terminal: '2', gate: 'C11' },
  ...over,
})

describe('AeroDataBox pushes, without a database', () => {
  it('normalizes flight numbers and reads AeroDataBox times', () => {
    expect(subjectFor('b6', ' 1017')).toBe('B61017')
    expect(canonNumber('DL 047')).toBe(canonNumber('dl47'))
    expect(canonNumber('B6 1017')).toBe('B61017')
    expect(parseUtc('2033-02-01 14:05Z')?.toISOString()).toBe('2033-02-01T14:05:00.000Z')
    expect(parseUtc('nonsense')).toBeNull()
    expect(parseUtc(null)).toBeNull()
  })

  it('matches a push to the booked flight by number, route and day', () => {
    expect(matchesFlight(pushed(), spec)).toBe(true)
    // The same number the next day is another flight.
    expect(
      matchesFlight(
        pushed({ departure: { airport: { iata: 'BOS' }, scheduledTime: { utc: '2033-02-02 14:00Z' } } }),
        spec,
      ),
    ).toBe(false)
    expect(matchesFlight(pushed({ arrival: { airport: { iata: 'JFK' } } }), spec)).toBe(false)
    expect(matchesFlight(pushed({ number: 'B6 1018' }), spec)).toBe(false)
    const older = pushed({ status: 'Expected', lastUpdatedUtc: '2033-02-01 12:00Z' })
    const newer = pushed({ status: 'Boarding', lastUpdatedUtc: '2033-02-01 13:30Z' })
    expect(pickMatch([newer, older], spec)?.status).toBe('Boarding')
  })

  it('turns a push into the board’s terms', () => {
    const scheduled = toLiveState(pushed(), spec)
    expect(scheduled).toMatchObject({ status: 'scheduled', gate: 'C11', terminal: 'Terminal 2', baggage: null })
    const late = toLiveState(
      pushed({
        arrival: { ...pushed().arrival, revisedTime: { utc: '2033-02-01 16:55Z' } },
      }),
      spec,
    )
    expect(late.status).toBe('delayed')
    expect(late.arrival.toISOString()).toBe('2033-02-01T16:55:00.000Z')
    expect(toLiveState(pushed({ status: 'EnRoute' }), spec).status).toBe('departed')
    expect(toLiveState(pushed({ status: 'Canceled' }), spec).status).toBe('cancelled')
    const landed = toLiveState(
      pushed({
        status: 'Arrived',
        arrival: { ...pushed().arrival, runwayTime: { utc: '2033-02-01 16:02Z' }, baggageBelt: '6' },
      }),
      spec,
    )
    expect(landed).toMatchObject({ status: 'landed', baggage: '6' })
    expect(landed.arrival.toISOString()).toBe('2033-02-01T16:02:00.000Z')
    // Leaving Raleigh: the gate comes from the departure end.
    const leaving = toLiveState(
      pushed({ departure: { airport: { iata: 'RDU' }, gate: 'A4' }, arrival: { airport: { iata: 'BOS' } } }),
      { ...spec, direction: 'departure', fromAirport: 'RDU', toAirport: 'BOS' },
    )
    expect(leaving.gate).toBe('A4')
  })

  it('calls AeroDataBox directly with the key header, and never reports the key', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (init.method === 'DELETE') return new Response('', { status: 404 })
      if (url.endsWith('/subscriptions/balance')) return Response.json({ creditsRemaining: 412 })
      return Response.json({ id: 'sub-1', isActive: true })
    }) as typeof fetch
    const api = adbClient('secret-key', fake)
    expect(await api.subscribe('B61017', 'https://app.test/api/flight-push/t')).toEqual({ id: 'sub-1' })
    expect(calls[0]!.url).toBe('https://api.aerodatabox.com/subscriptions/webhook/FlightByNumber/B61017')
    expect((calls[0]!.init.headers as Record<string, string>)['X-Api-Key']).toBe('secret-key')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      url: 'https://app.test/api/flight-push/t',
      maxDeliveryRetries: 1,
    })
    await expect(api.unsubscribe('gone')).resolves.toBeUndefined()
    expect(await api.balance()).toBe(412)
    const failing = adbClient('secret-key', (async () => new Response('nope', { status: 401 })) as typeof fetch)
    await expect(failing.subscribe('B61017', 'u')).rejects.toThrow('HTTP 401')
    await expect(failing.subscribe('B61017', 'u')).rejects.not.toThrow('secret-key')
  })

  it('the push endpoint turns away bad tokens, and needs Inngest', async () => {
    const post = (path: string) =>
      handleFlightPush(new Request(`https://app.test${path}`, { method: 'POST', body: '{}' }))
    expect((await post('/api/flight-push/short')).status).toBe(404)
    expect((await handleFlightPush(new Request('https://app.test/api/flight-push/x', { method: 'GET' }))).status).toBe(
      405,
    )
    const saved = { key: process.env.INNGEST_SIGNING_KEY, dev: process.env.INNGEST_DEV }
    delete process.env.INNGEST_SIGNING_KEY
    delete process.env.INNGEST_DEV
    try {
      expect((await post(`/api/flight-push/${newToken()}`)).status).toBe(503)
    } finally {
      if (saved.key !== undefined) process.env.INNGEST_SIGNING_KEY = saved.key
      if (saved.dev !== undefined) process.env.INNGEST_DEV = saved.dev
    }
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).not.toBe('abc')
  })

  it('the push feed needs both the setting and a key', () => {
    expect(pushFeedOn({})).toBe(false)
    expect(pushFeedOn({ FLIGHT_FEED: 'aerodatabox' })).toBe(false)
    expect(pushFeedOn({ AERODATABOX_API_KEY: 'k' })).toBe(false)
    expect(pushFeedOn({ FLIGHT_FEED: 'aerodatabox', AERODATABOX_API_KEY: 'k' })).toBe(true)
  })

  it('long waits are split into sleeps of six days or less', async () => {
    const sleeps: { id: string; at: Date }[] = []
    const step = { sleepUntil: async (id: string, at: Date) => void sleeps.push({ id, at }) }
    const from = Date.UTC(2033, 0, 1)
    await sleepInPieces(step, 'wait', from, new Date(from + 20 * 86_400_000))
    expect(sleeps.map((s) => s.id)).toEqual(['wait-0', 'wait-1', 'wait-2', 'wait-3'])
    expect(sleeps.at(-1)!.at.getTime()).toBe(from + 20 * 86_400_000)
    sleeps.length = 0
    await sleepInPieces(step, 'soon', from, new Date(from + 3_600_000))
    expect(sleeps.map((s) => s.id)).toEqual(['soon-0'])
  })
})

/** Stands in for AeroDataBox: records subscriptions, sends nothing. */
function fakeApi() {
  const live = new Set<string>()
  let n = 0
  const api: AdbClient = {
    subscribe: async () => {
      const id = `fake-${++n}`
      live.add(id)
      return { id }
    },
    unsubscribe: async (id) => void live.delete(id),
    balance: async () => 100,
  }
  return { api, live, created: () => n }
}

const url = process.env.DATABASE_URL
describe.skipIf(!url)('AeroDataBox pushes against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const tag = randomUUID().slice(0, 8)
  const cm: SessionUser = {
    id: `test-${randomUUID()}`,
    email: `push-${tag}@example.com`,
    name: 'Sam',
    twoFactorEnabled: true,
  }
  const asCm = () => createCaller({ db, user: cm })
  const people: string[] = []
  const flights: string[] = []
  const subs: string[] = []
  let seasonId = ''
  // A flight number nobody else's test uses.
  const num = String(1000 + Math.floor(Math.random() * 8000))

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await db.insert(user).values({ id: cm.id, email: cm.email, name: cm.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: cm.id, role: 'company_manager' })
    seasonId = (
      await asCm().seasons.create({
        name: `Push ${tag}`,
        program: 'main_stage',
        startsOn: '2033-01-01',
        endsOn: '2033-12-31',
      })
    ).id
    const productionId = (
      await asCm().productions.create({
        seasonId,
        title: `Push play ${tag}`,
        rehearsalStart: '2033-02-02',
        closing: '2033-03-14',
      })
    ).id
    for (const name of [`Flyer ${tag}`, `Second ${tag}`]) {
      const r = await asCm().engagements.quickCreate({
        productionId,
        person: { kind: 'new', person: { legalName: name } },
        agent: { kind: 'none' },
        terms: { role: 'Lead', contractType: 'equity_itc', travelProvided: true },
        conflicts: [],
      })
      people.push(r.personId)
      const f = await asCm().travel.addFlight({
        engagementId: r.id,
        direction: 'arrival',
        airline: 'B6',
        flightNumber: num,
        fromAirport: 'BOS',
        toAirport: 'RDU',
        departLocal: '2033-02-01T09:00',
        arriveLocal: '2033-02-01T11:10',
      })
      flights.push(f.id)
    }
  })

  afterAll(async () => {
    const prods = db.select({ id: production.id }).from(production).where(eq(production.seasonId, seasonId))
    await db.delete(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(production).where(eq(production.seasonId, seasonId))
    await db.delete(season).where(eq(season.id, seasonId))
    if (people.length) await db.delete(person).where(inArray(person.id, people))
    if (subs.length) await db.delete(flightSubscription).where(inArray(flightSubscription.id, subs))
    await db.delete(user).where(eq(user.id, cm.id))
  })

  it('two flights with the same number share one subscription, applied by route and day', async () => {
    const { api, live, created } = fakeApi()
    const a = await watchFlight(db, api, flights[0]!, 'https://app.test')
    const b = await watchFlight(db, api, flights[1]!, 'https://app.test')
    expect(a).toBeTruthy()
    expect(b).toBe(a)
    expect(created()).toBe(1)
    subs.push(a!)

    const item = (over: Partial<AdbFlightItem>) =>
      pushed({
        number: `B6 ${num}`,
        departure: { airport: { iata: 'BOS' }, scheduledTime: { utc: '2033-02-01 14:00Z' } },
        ...over,
      })
    const late = await applyPush(
      db,
      a!,
      {
        flights: [
          item({
            arrival: {
              airport: { iata: 'RDU' },
              scheduledTime: { utc: '2033-02-01 16:10Z' },
              revisedTime: { utc: '2033-02-01 16:55Z' },
            },
          }),
          // The same number tomorrow: not ours.
          item({
            status: 'Canceled',
            departure: { airport: { iata: 'BOS' }, scheduledTime: { utc: '2033-02-02 14:00Z' } },
          }),
        ],
        balance: { creditsRemaining: 40 },
      },
      new Date('2033-02-01T13:00:00Z'),
    )
    expect(late).toMatchObject({ purpose: 'flight', stored: 2, credits: 40, finished: [] })
    expect(late.events).toBeGreaterThanOrEqual(2)
    const [row] = await db.select().from(flight).where(eq(flight.id, flights[0]!))
    expect(row!.liveStatus).toBe('delayed')
    const kinds = (await db.select().from(flightEvent).where(eq(flightEvent.flightId, flights[0]!))).map((e) => e.kind)
    expect(kinds).toContain('delayed')
    expect(kinds).not.toContain('cancelled')

    const landed = await applyPush(
      db,
      a!,
      {
        flights: [
          item({ status: 'Arrived', arrival: { airport: { iata: 'RDU' }, runwayTime: { utc: '2033-02-01 16:50Z' } } }),
        ],
      },
      new Date('2033-02-01T17:00:00Z'),
    )
    expect(landed.finished.sort()).toEqual([...flights].sort())

    // Letting go of one flight keeps the subscription for the other.
    expect(await releaseFlight(db, api, flights[0]!)).toBe(false)
    expect(live.size).toBe(1)
    expect(await releaseFlight(db, api, flights[1]!)).toBe(true)
    expect(live.size).toBe(0)
    const [sub] = await db.select().from(flightSubscription).where(eq(flightSubscription.id, a!))
    expect(sub!.active).toBe(false)
    // An ended subscription ignores late pushes.
    expect((await applyPush(db, a!, { flights: [item({})] }, new Date())).stored).toBe(0)
  })

  it('a staff test reports status changes, ends on landing, and is capped', async () => {
    const { api } = fakeApi()
    await expect(
      startTest(db, api, { flightNumber: 'not a flight', userId: cm.id, origin: 'https://app.test' }),
    ).rejects.toThrow()
    const test = await startTest(db, api, { flightNumber: `b6 ${num}`, userId: cm.id, origin: 'https://app.test' })
    subs.push(test.id)
    expect(test.flightNumber).toBe(`B6${num}`)
    expect(test.providerId).toBe('fake-1')
    const first = await applyPush(db, test.id, { flights: [pushed({ status: 'Boarding' })] }, new Date())
    expect(first).toMatchObject({ purpose: 'test', startedBy: cm.id, testFinished: false })
    expect(first.testLines).toHaveLength(1)
    const same = await applyPush(
      db,
      test.id,
      { flights: [pushed({ status: 'Boarding' })] },
      new Date(Date.now() + 1000),
    )
    expect(same.testLines).toHaveLength(0)
    const done = await applyPush(db, test.id, { flights: [pushed({ status: 'Arrived' })] }, new Date(Date.now() + 2000))
    expect(done.testFinished).toBe(true)
    expect(await endSubscription(db, api, test.id)).toBe(true)
    expect(await endSubscription(db, api, test.id)).toBe(false)

    const running: string[] = []
    try {
      for (let i = 0; i < MAX_TESTS; i++) {
        running.push(
          (await startTest(db, api, { flightNumber: `AA${i + 1}`, userId: cm.id, origin: 'https://app.test' })).id,
        )
      }
      await expect(
        startTest(db, api, { flightNumber: 'AA9', userId: cm.id, origin: 'https://app.test' }),
      ).rejects.toThrow('at once')
    } finally {
      for (const id of running) await endSubscription(db, api, id)
      subs.push(...running)
    }
  })

  it('a running test stays listed, with its Stop button, however many ended after it', async () => {
    const { api } = fakeApi()
    const stuck = await startTest(db, api, { flightNumber: 'UA1', userId: cm.id, origin: 'https://app.test' })
    subs.push(stuck.id)
    try {
      for (let i = 0; i < 6; i++) {
        const t = await startTest(db, api, { flightNumber: `UA${i + 2}`, userId: cm.id, origin: 'https://app.test' })
        subs.push(t.id)
        await endSubscription(db, api, t.id)
      }
      const listed = await listTests(db)
      expect(listed.find((t) => t.id === stuck.id)).toMatchObject({ active: true })
    } finally {
      await endSubscription(db, api, stuck.id)
    }
  })
})
