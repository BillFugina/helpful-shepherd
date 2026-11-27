import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { arrivalSummaryEmail, arrivalsOn, sendArrivalSummaries } from '../server/alerts/arrivals-summary.js'
import {
  describeAlert,
  flightAlertEmail,
  flightAlertNotice,
  sendFlightAlerts,
  type AlertItem,
} from '../server/alerts/flight-alerts.js'
import { companyManagers } from '../server/alerts/recipients.js'
import { createDb, type Db } from '../server/db/client.js'
import {
  engagement,
  flightEvent,
  housingUnit,
  person,
  production,
  season,
  user,
  userRole,
} from '../server/db/schema.js'
import type { OutgoingEmail, sendEmail } from '../server/email/send.js'
import { simulatedProvider } from '../server/flights/provider.js'
import { trackFlights } from '../server/flights/track.js'
import { inngestEnabled } from '../server/inngest/client.js'
import { handleInngest } from '../server/inngest/handler.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import type { Role } from '../shared/access.js'

const createCaller = createCallerFactory(appRouter)

const item = (over: Partial<AlertItem>): AlertItem => ({
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

describe('flight alerts and the scheduled job, without a database', () => {
  it('says who, which flight and what changed, in theatre time', () => {
    expect(describeAlert(item({}))).toBe('Avery (The Play), B6 1017 from BOS: late by 45 min, now lands at 11:55 AM.')
    expect(describeAlert(item({ kind: 'gate_change', detail: { from: 'C4', to: 'C11' } }))).toContain(
      'gate changed from C4 to C11',
    )
    expect(describeAlert(item({ kind: 'landed', detail: { baggage: '6' } }))).toContain(
      'landed at 11:55 AM, bags at claim 6',
    )
    expect(describeAlert(item({ kind: 'cancelled', detail: null }))).toContain('cancelled')
    expect(describeAlert(item({ direction: 'departure', toAirport: 'BOS', fromAirport: 'RDU' }))).toContain(
      'B6 1017 to BOS: late by 45 min, now leaves at 9:45 AM',
    )
  })

  it('writes one email for one change or many, and says when the feed is simulated', () => {
    const one = flightAlertEmail({
      recipientName: 'Sam CM',
      items: [item({})],
      boardUrl: 'https://a.test/arrivals',
      simulated: true,
    })
    expect(one.subject).toBe("Avery's flight is delayed")
    expect(one.text).toContain('Hi Sam,')
    expect(one.text).toContain('https://a.test/arrivals')
    expect(one.text).toContain('simulated flight feed')
    const many = flightAlertEmail({
      recipientName: '',
      items: [item({}), item({ kind: 'landed', detail: null })],
      boardUrl: 'https://a.test/arrivals',
      simulated: false,
    })
    expect(many.subject).toBe('2 flight updates')
    expect(many.text).not.toContain('simulated')
  })

  it('the summary shows place and room only when the reader may see housing', () => {
    const summary = {
      productionId: randomUUID(),
      title: 'The Play',
      date: '2033-02-01',
      people: [
        {
          engagementId: randomUUID(),
          name: 'Avery',
          role: 'Lead',
          flight: {
            airline: 'B6',
            flightNumber: '1017',
            fromAirport: 'BOS',
            landsAt: new Date('2033-02-01T16:10:00Z'),
            cancelled: false,
          },
          car: { company: 'Hertz', pickupAt: new Date('2033-02-01T16:40:00Z'), pickupPlace: 'RDU' },
          housing: { place: 'Company house', room: 'Room 2' },
        },
      ],
    }
    const withHousing = arrivalSummaryEmail({ recipientName: 'Sam', summary, showHousing: true, boardUrl: 'u' })
    expect(withHousing.subject).toBe('Arriving tomorrow for The Play: 1 person')
    expect(withHousing.text).toContain('Tue, Feb 1')
    expect(withHousing.text).toContain('B6 1017 from BOS, lands 11:10 AM.')
    expect(withHousing.text).toContain('Car: Hertz, pickup 11:40 AM at RDU.')
    expect(withHousing.text).toContain('Staying: Company house, Room 2.')
    const cancelled = arrivalSummaryEmail({
      recipientName: 'Sam',
      summary: {
        ...summary,
        people: [{ ...summary.people[0]!, flight: { ...summary.people[0]!.flight!, cancelled: true } }],
      },
      showHousing: true,
      boardUrl: 'u',
    })
    expect(cancelled.text).toContain('B6 1017 from BOS was cancelled. They need a new flight.')
    expect(cancelled.text).not.toContain('lands 11:10 AM')
    const without = arrivalSummaryEmail({ recipientName: 'Sam', summary, showHousing: false, boardUrl: 'u' })
    expect(without.text).not.toContain('Company house')
  })

  it('the Inngest endpoint is off without a signing key, and dev mode never counts on Vercel', async () => {
    expect(inngestEnabled({})).toBe(false)
    expect(inngestEnabled({ INNGEST_SIGNING_KEY: 'signkey-prod-x' })).toBe(true)
    expect(inngestEnabled({ INNGEST_DEV: '1' })).toBe(true)
    expect(inngestEnabled({ INNGEST_DEV: '0' })).toBe(false)
    expect(inngestEnabled({ INNGEST_DEV: '1', VERCEL: '1' })).toBe(false)
    const saved = { key: process.env.INNGEST_SIGNING_KEY, dev: process.env.INNGEST_DEV }
    delete process.env.INNGEST_SIGNING_KEY
    delete process.env.INNGEST_DEV
    try {
      const res = await handleInngest(new Request('http://localhost/api/inngest', { method: 'PUT' }))
      expect(res.status).toBe(404)
    } finally {
      if (saved.key !== undefined) process.env.INNGEST_SIGNING_KEY = saved.key
      if (saved.dev !== undefined) process.env.INNGEST_DEV = saved.dev
    }
  })
})

const url = process.env.DATABASE_URL
describe.skipIf(!url)('flight alerts and summaries against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const tag = randomUUID().slice(0, 8)
  const mk = (name: string): SessionUser => ({
    id: `test-${randomUUID()}`,
    email: `${name}-${tag}@example.com`,
    name,
    twoFactorEnabled: true,
  })
  const cm = mk('Sam')
  const cmNoTwoFactor = mk('Unfinished')
  const finance = mk('Fin')
  const asCm = () => createCaller({ db, user: cm })
  const people: string[] = []
  const units: string[] = []
  let seasonId = ''
  let productionTitle = ''
  let flyer = ''
  let noFlight = ''
  let flightId = ''

  // Captures what would be sent; nothing leaves the test.
  const outbox: OutgoingEmail[] = []
  const send = (async (msg: OutgoingEmail) => {
    outbox.push(msg)
    return { delivery: 'sent' as const }
  }) as typeof sendEmail
  const mine = () => outbox.filter((m) => m.to === cm.email)

  async function addUser(u: SessionUser, role: Role, twoFactorEnabled = true) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(cmNoTwoFactor, 'company_manager', false)
    await addUser(finance, 'finance_manager')
    seasonId = (
      await asCm().seasons.create({
        name: `Alerts ${tag}`,
        program: 'main_stage',
        startsOn: '2033-01-01',
        endsOn: '2033-12-31',
      })
    ).id
    productionTitle = `Alerts play ${tag}`
    const productionId = (
      await asCm().productions.create({
        seasonId,
        title: productionTitle,
        rehearsalStart: '2033-02-02',
        closing: '2033-03-14',
      })
    ).id
    for (const name of [`Flyer ${tag}`, `Driver ${tag}`]) {
      const r = await asCm().engagements.quickCreate({
        productionId,
        person: { kind: 'new', person: { legalName: name, cell: '919-555-0142' } },
        agent: { kind: 'none' },
        terms: {
          role: 'Lead',
          contractType: 'equity_itc',
          travelProvided: true,
          carProvided: true,
          housingProvided: true,
          preferredArrival: '2033-02-01',
          preferredDeparture: '2033-03-15',
        },
        conflicts: [],
      })
      people.push(r.personId)
      if (!flyer) flyer = r.id
      else noFlight = r.id
    }
    flightId = (
      await asCm().travel.addFlight({
        engagementId: flyer,
        direction: 'arrival',
        airline: 'B6',
        flightNumber: '1017',
        fromAirport: 'BOS',
        toAirport: 'RDU',
        departLocal: '2033-02-01T09:00',
        arriveLocal: '2033-02-01T11:10',
        confirmation: 'SECRET1',
      })
    ).id
    await asCm().travel.addCar({
      engagementId: flyer,
      company: 'Hertz',
      confirmation: 'CARCODE9',
      pickupLocal: '2033-02-01T11:40',
      pickupPlace: 'RDU rental lot',
      returnLocal: '2033-03-15T08:00',
    })
    const [unit] = await db
      .insert(housingUnit)
      .values({ name: `Company house ${tag}`, kind: 'company_house', address: '1 Hidden Lane', doorCode: '4321' })
      .returning()
    units.push(unit!.id)
    const room = await asCm().housing.addRoom({ unitId: unit!.id, name: 'Room 2', floor: 1, bathroom: 'Hall' })
    await asCm().housing.assign({ engagementId: flyer, roomId: room.id, startsOn: '2033-02-01', endsOn: '2033-03-15' })
  })

  afterAll(async () => {
    const prods = db.select({ id: production.id }).from(production).where(eq(production.seasonId, seasonId))
    await db.delete(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(production).where(eq(production.seasonId, seasonId))
    await db.delete(season).where(eq(season.id, seasonId))
    if (people.length) await db.delete(person).where(inArray(person.id, people))
    if (units.length) await db.delete(housingUnit).where(inArray(housingUnit.id, units))
    await db.delete(user).where(inArray(user.id, [cm.id, cmNoTwoFactor.id, finance.id]))
  })

  it('only Company Managers who finished two-factor get the emails', async () => {
    const ids = (await companyManagers(db, 'travel_logistics')).map((r) => r.userId)
    expect(ids).toContain(cm.id)
    expect(ids).not.toContain(cmNoTwoFactor.id)
    expect(ids).not.toContain(finance.id)
  })

  it('emails a delay once, then the landing, with no booking codes or phone numbers', async () => {
    // An hour before take-off the simulated feed knows a flight ending in 7 is 45 minutes late.
    const before = new Date('2033-02-01T13:00:00Z')
    await trackFlights(db, simulatedProvider, before)
    outbox.length = 0
    const first = await sendFlightAlerts(db, { now: before, origin: 'https://app.test', simulated: true, send })
    expect(first.alerts).toBeGreaterThanOrEqual(1)
    expect(mine()).toHaveLength(1)
    expect(mine()[0]!.text).toContain(`Flyer ${tag} (${productionTitle}), B6 1017 from BOS: late by 45 min`)
    expect(mine()[0]!.text).toContain('https://app.test/arrivals')
    expect(outbox.some((m) => m.to === finance.email || m.to === cmNoTwoFactor.email)).toBe(false)

    // Already sent: a second run right away has nothing new.
    outbox.length = 0
    await sendFlightAlerts(db, { now: before, origin: 'https://app.test', simulated: true, send })
    expect(mine()).toHaveLength(0)

    // After it lands (16:10 + 45 min), the landing goes out with the bag claim.
    const after = new Date('2033-02-01T17:30:00Z')
    await trackFlights(db, simulatedProvider, after)
    await sendFlightAlerts(db, { now: after, origin: 'https://app.test', simulated: true, send })
    expect(mine()).toHaveLength(1)
    expect(mine()[0]!.text).toMatch(/landed at 11:55 AM, bags at claim \d/)
    const all = outbox.map((m) => m.subject + m.text).join('\n')
    expect(all).not.toContain('SECRET1')
    expect(all).not.toContain('919-555-0142')
  })

  it('old news and in-the-air changes are marked done without an email', async () => {
    const now = new Date('2033-02-01T18:00:00Z')
    const [stale] = await db
      .insert(flightEvent)
      .values({
        flightId,
        at: new Date(now.getTime() - 7 * 3_600_000),
        kind: 'gate_change',
        detail: { from: 'C1', to: 'C2' },
      })
      .returning()
    const [departed] = await db.insert(flightEvent).values({ flightId, at: now, kind: 'departed' }).returning()
    outbox.length = 0
    const res = await sendFlightAlerts(db, { now, origin: 'https://app.test', simulated: true, send })
    expect(res.alerts).toBe(0)
    expect(mine()).toHaveLength(0)
    const rows = await db
      .select()
      .from(flightEvent)
      .where(inArray(flightEvent.id, [stale!.id, departed!.id]))
    expect(rows.every((r) => r.alertedAt !== null)).toBe(true)
  })

  it('hands the push step ids only, and the phone alert is rebuilt from them', async () => {
    const now = new Date('2033-02-01T18:00:00Z')
    const [ev] = await db.insert(flightEvent).values({ flightId, at: now, kind: 'cancelled' }).returning()
    const res = await sendFlightAlerts(db, { now, origin: 'https://app.test', simulated: true, send })
    expect(res.eventIds).toEqual([ev!.id])
    // What the job keeps in its history: counts and ids, no names or flights.
    expect(JSON.stringify(res)).not.toMatch(/cancel|arrivals|\(/i)
    const notice = await flightAlertNotice(db, res.eventIds, true)
    expect(notice?.title).toContain('flight is cancelled')
    expect(notice?.body).toContain('Simulated demo flights')
    expect(notice?.path).toBe('/arrivals')
    expect(await flightAlertNotice(db, [], true)).toBeNull()
  })

  it('if every email fails, the change is put back for the retry', async () => {
    const now = new Date('2033-02-01T18:00:00Z')
    const [ev] = await db.insert(flightEvent).values({ flightId, at: now, kind: 'cancelled' }).returning()
    const failing = (async () => {
      throw new Error('down')
    }) as typeof sendEmail
    await expect(
      sendFlightAlerts(db, { now, origin: 'https://app.test', simulated: true, send: failing }),
    ).rejects.toThrow()
    const [row] = await db.select().from(flightEvent).where(eq(flightEvent.id, ev!.id))
    expect(row?.alertedAt).toBeNull()
    outbox.length = 0
    await sendFlightAlerts(db, { now, origin: 'https://app.test', simulated: true, send })
    expect(mine()[0]!.text).toContain('cancelled')
  })

  it('summarizes tomorrow’s arrivals by production, with place and room but never access details', async () => {
    const summaries = await arrivalsOn(db, '2033-02-01')
    const ours = summaries.find((s) => s.title === productionTitle)!
    expect(ours.people.map((p) => p.engagementId)).toEqual([flyer, noFlight])
    expect(ours.people[0]!.housing).toEqual({ place: `Company house ${tag}`, room: 'Room 2' })
    expect(ours.people[1]!.flight).toBeNull()

    outbox.length = 0
    await sendArrivalSummaries(db, { date: '2033-02-01', origin: 'https://app.test', send })
    const email = mine().find((m) => m.subject.includes(productionTitle))!
    expect(email.subject).toBe(`Arriving tomorrow for ${productionTitle}: 2 people`)
    // The tracker logged a 45-minute delay earlier, so the summary uses the live landing time.
    expect(email.text).toContain('B6 1017 from BOS, lands 11:55 AM.')
    expect(email.text).toContain('Car: Hertz, pickup 11:40 AM at RDU rental lot.')
    expect(email.text).toContain(`Staying: Company house ${tag}, Room 2.`)
    expect(email.text).toContain(`Driver ${tag} (Lead): No flight logged yet.`)
    expect(email.text).toContain('https://app.test/arrivals?date=2033-02-01')
    for (const secret of ['1 Hidden Lane', '4321', 'SECRET1', 'CARCODE9', '919-555-0142']) {
      expect(email.text).not.toContain(secret)
    }
    expect(outbox.some((m) => m.to === finance.email)).toBe(false)

    // A retry or a second run the same day doesn't send it again.
    outbox.length = 0
    const again = await sendArrivalSummaries(db, { date: '2033-02-01', origin: 'https://app.test', send })
    expect(again.skipped).toBeGreaterThanOrEqual(1)
    expect(mine().some((m) => m.subject.includes(productionTitle))).toBe(false)
  })
})
