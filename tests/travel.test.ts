import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../server/db/client.js'
import {
  auditEvent,
  engagement,
  flight,
  housingAssignment,
  housingUnit,
  person,
  production,
  season,
  user,
  userRole,
} from '../server/db/schema.js'
import { simulateStatus, type FlightSpec } from '../server/flights/provider.js'
import { changesBetween, setDemoClock } from '../server/flights/track.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import type { Role } from '../shared/access.js'
import { dayBounds, utcToLocal, zonedToUtc } from '../shared/time.js'
import { housingWarnings, staysOverlap, type StayForCheck } from '../shared/travel.js'

describe('time zones', () => {
  it('turns airport-local times into instants, across the spring DST change', () => {
    expect(zonedToUtc('2027-01-10T09:00', 'America/New_York').toISOString()).toBe('2027-01-10T14:00:00.000Z')
    expect(zonedToUtc('2027-03-14T12:00', 'America/New_York').toISOString()).toBe('2027-03-14T16:00:00.000Z')
    expect(zonedToUtc('2027-01-10T09:00', 'America/Los_Angeles').toISOString()).toBe('2027-01-10T17:00:00.000Z')
    expect(utcToLocal(new Date('2027-03-14T16:00:00Z'), 'America/New_York')).toBe('2027-03-14T12:00')
  })

  it('a theater-local day is 23 hours long when the clocks spring forward', () => {
    const { start, end } = dayBounds('2027-03-14', 'America/New_York')
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23)
  })
})

const spec = (flightNumber: string): FlightSpec => ({
  direction: 'arrival',
  airline: 'DL',
  flightNumber,
  fromAirport: 'LGA',
  toAirport: 'RDU',
  scheduledDeparture: new Date('2027-01-10T14:00:00Z'),
  scheduledArrival: new Date('2027-01-10T15:45:00Z'),
})
const at = (iso: string) => new Date(iso)

describe('simulated flight feed', () => {
  it('a flight ending in 7 runs 45 minutes late, known two hours out', () => {
    expect(simulateStatus(spec('2007'), at('2027-01-10T11:00:00Z')).status).toBe('scheduled')
    const late = simulateStatus(spec('2007'), at('2027-01-10T12:30:00Z'))
    expect(late.status).toBe('delayed')
    expect(late.arrival.toISOString()).toBe('2027-01-10T16:30:00.000Z')
    expect(simulateStatus(spec('2007'), at('2027-01-10T15:00:00Z')).status).toBe('departed')
    const landed = simulateStatus(spec('2007'), at('2027-01-10T16:30:00Z'))
    expect(landed.status).toBe('landed')
    expect(landed.baggage).toBeTruthy()
  })

  it('a flight ending in 9 is cancelled three hours out', () => {
    expect(simulateStatus(spec('2009'), at('2027-01-10T10:00:00Z')).status).toBe('scheduled')
    expect(simulateStatus(spec('2009'), at('2027-01-10T11:00:00Z')).status).toBe('cancelled')
  })

  it('a flight ending in 3 changes gate an hour before landing', () => {
    const before = simulateStatus(spec('2003'), at('2027-01-10T13:00:00Z'))
    const after = simulateStatus(spec('2003'), at('2027-01-10T15:00:00Z'))
    expect(before.gate).toBeTruthy()
    expect(after.gate).not.toBe(before.gate)
  })

  it('logs bad news on the first look, and only what changed after that', () => {
    const row = {
      ...spec('2003'),
      id: randomUUID(),
      engagementId: randomUUID(),
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
    const first = simulateStatus(row, at('2027-01-10T13:00:00Z'))
    expect(changesBetween(row, first)).toEqual([])
    const seen = { ...row, liveStatus: first.status, liveGate: first.gate, liveArrival: first.arrival }
    const next = simulateStatus(row, at('2027-01-10T15:00:00Z'))
    expect(changesBetween(seen, next).map((c) => c.kind)).toEqual(['gate_change', 'departed'])

    const late = simulateStatus(spec('2007'), at('2027-01-10T12:30:00Z'))
    expect(changesBetween({ ...row, flightNumber: '2007' }, late)).toEqual([
      { kind: 'delayed', detail: { minutes: 45 } },
    ])
  })
})

describe('housing warnings', () => {
  const stay = (over: Partial<StayForCheck>): StayForCheck => ({
    assignmentId: randomUUID(),
    engagementId: randomUUID(),
    personId: randomUUID(),
    personName: 'Someone',
    unitId: 'house',
    roomId: 'room-1',
    roomName: 'Room 1',
    floor: 1,
    bathroom: 'Downstairs bath',
    startsOn: '2027-01-10',
    endsOn: '2027-02-15',
    ...over,
  })

  it('stays share a night only when they overlap; the move-out day is free', () => {
    expect(
      staysOverlap({ startsOn: '2027-01-10', endsOn: '2027-01-12' }, { startsOn: '2027-01-12', endsOn: '2027-01-14' }),
    ).toBe(false)
    expect(
      staysOverlap({ startsOn: '2027-01-10', endsOn: '2027-01-13' }, { startsOn: '2027-01-12', endsOn: '2027-01-14' }),
    ).toBe(true)
  })

  it('warns about a shared bathroom, an upstairs room and travel outside the stay', () => {
    const priya = stay({ personName: 'Priya' })
    const dez = stay({ personName: 'Dez', roomId: 'room-2', roomName: 'Room 2' })
    const harper = stay({
      personName: 'Harper',
      roomId: 'room-4',
      roomName: 'Room 4',
      floor: 2,
      bathroom: 'Upstairs bath',
    })
    const rules = new Map([
      [priya.personId, ['private_bathroom' as const]],
      [harper.personId, ['ground_floor' as const]],
    ])
    const travel = new Map([[dez.engagementId, { arrivesOn: '2027-01-09', leavesOn: '2027-02-16' }]])
    const kinds = housingWarnings([priya, dez, harper], rules, travel).map((w) => w.kind)
    expect(kinds.sort()).toEqual(['arrives_before_housing', 'ground_floor', 'leaves_after_housing', 'private_bathroom'])
  })

  it("doesn't warn when the bathroom-sharer's stay doesn't overlap", () => {
    const priya = stay({ personName: 'Priya', endsOn: '2027-01-20' })
    const dez = stay({ personName: 'Dez', roomId: 'room-2', startsOn: '2027-01-20' })
    expect(housingWarnings([priya, dez], new Map([[priya.personId, ['private_bathroom' as const]]]))).toEqual([])
  })
})

const createCaller = createCallerFactory(appRouter)

function fakeUser(): SessionUser {
  const id = `test-${randomUUID()}`
  return { id, email: `${id}@example.com`, name: 'Tester', twoFactorEnabled: true }
}

// Runs only when a migrated database is available (CI provides one).
const url = process.env.DATABASE_URL
describe.skipIf(!url)('travel and housing against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const cm = fakeUser()
  const finance = fakeUser()
  const tag = randomUUID().slice(0, 8)
  const units: string[] = []
  let seasonId = ''
  let engagementId = ''
  let otherEngagementId = ''
  const people: string[] = []

  const asCm = () => createCaller({ db, user: cm })
  const asFinance = () => createCaller({ db, user: finance })

  async function addUser(u: SessionUser, role: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(finance, 'finance_manager')
    seasonId = (
      await asCm().seasons.create({
        name: `Travel season ${tag}`,
        program: 'main_stage',
        startsOn: '2032-01-01',
        endsOn: '2032-12-31',
      })
    ).id
    const productionId = (
      await asCm().productions.create({
        seasonId,
        title: `Travel production ${tag}`,
        rehearsalStart: '2032-02-02',
        closing: '2032-03-14',
      })
    ).id
    for (const [name, airport] of [
      [`Traveler ${tag}`, 'BOS'],
      [`Roommate ${tag}`, 'ORD'],
    ] as const) {
      const r = await asCm().engagements.quickCreate({
        productionId,
        person: { kind: 'new', person: { legalName: name, homeAirport: airport, cell: '919-555-0199' } },
        agent: { kind: 'none' },
        terms: {
          role: 'Lead',
          contractType: 'equity_itc',
          travelProvided: true,
          housingProvided: true,
          preferredArrival: '2032-02-01',
          preferredDeparture: '2032-03-15',
        },
        conflicts: [],
      })
      people.push(r.personId)
      if (!engagementId) engagementId = r.id
      else otherEngagementId = r.id
    }
  })

  afterAll(async () => {
    await setDemoClock(db, 0)
    const prods = db.select({ id: production.id }).from(production).where(eq(production.seasonId, seasonId))
    await db.delete(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(production).where(eq(production.seasonId, seasonId))
    await db.delete(season).where(eq(season.id, seasonId))
    if (people.length) await db.delete(person).where(inArray(person.id, people))
    if (units.length) await db.delete(housingUnit).where(inArray(housingUnit.id, units))
    await db.delete(user).where(inArray(user.id, [cm.id, finance.id]))
  })

  it('Finance sees no travel or housing', async () => {
    await expect(asFinance().arrivals.board({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(asFinance().housing.units()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      asFinance().travel.addCar({
        engagementId,
        company: 'Nope',
        pickupLocal: '2032-02-01T12:00',
        returnLocal: '2032-03-15T08:00',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const it = await asFinance().travel.forEngagement({ engagementId })
    expect(it.flights).toBeUndefined()
    expect(it.housing).toBeUndefined()
  })

  it('a flight typed in airport time shows on that day’s board, and the feed logs its delay', async () => {
    const { id } = await asCm().travel.addFlight({
      engagementId,
      direction: 'arrival',
      airline: 'B6',
      flightNumber: '1017',
      fromAirport: 'BOS',
      toAirport: 'RDU',
      departLocal: '2032-02-01T09:00',
      arriveLocal: '2032-02-01T11:10',
      confirmation: 'TEST01',
    })
    const [row] = await db.select().from(flight).where(eq(flight.id, id))
    expect(row?.scheduledDeparture.toISOString()).toBe('2032-02-01T14:00:00.000Z')

    // An hour before take-off, the simulated feed knows a flight ending in 7 is 45 minutes late.
    await asCm().arrivals.setClock({ at: '2032-02-01T13:00:00Z' })
    const board = await asCm().arrivals.board({})
    expect(board.date).toBe('2032-02-01')
    const mine = board.arrivals.find((a) => a.engagementId === engagementId)
    expect(mine?.legs[0]?.liveStatus).toBe('delayed')
    expect(mine?.cell).toBe('919-555-0199')
    expect(board.alerts.some((a) => a.kind === 'delayed' && a.engagementId === engagementId)).toBe(true)
    // The roommate has no flight yet, so the board lists them as expected without one.
    expect(board.arrivingNoFlight.map((p) => p.engagementId)).toContain(otherEngagementId)

    // Moving the clock clears what the feed said; resetting puts real time back.
    await asCm().arrivals.resetClock()
    const [cleared] = await db.select().from(flight).where(eq(flight.id, id))
    expect(cleared?.liveStatus).toBeNull()
    await expect(asFinance().arrivals.setClock({ at: '2032-02-01T13:00:00Z' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    const events = await db.select().from(auditEvent).where(eq(auditEvent.recordId, id))
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events.map((e) => e.detail))).not.toContain('TEST01')
  })

  it('a room can’t be double-booked, but a shared bathroom is only a warning', async () => {
    const unit = await asCm().housing.createUnit({ name: `Test house ${tag}`, kind: 'company_house' })
    units.push(unit.id)
    const r1 = await asCm().housing.addRoom({ unitId: unit.id, name: 'Room 1', floor: 1, bathroom: 'Hall bath' })
    const r2 = await asCm().housing.addRoom({ unitId: unit.id, name: 'Room 2', floor: 1, bathroom: 'Hall bath' })

    await asCm().housing.assign({ engagementId, roomId: r1.id, startsOn: '2032-02-01', endsOn: '2032-03-15' })
    await expect(
      asCm().housing.assign({
        engagementId: otherEngagementId,
        roomId: r1.id,
        startsOn: '2032-03-01',
        endsOn: '2032-03-15',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Room 1 is taken') })
    await expect(
      asCm().housing.assign({ engagementId, roomId: r2.id, startsOn: '2032-02-10', endsOn: '2032-02-12' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    await asCm().housing.setPreference({ personId: people[0]!, rule: 'private_bathroom' })
    await asCm().housing.assign({
      engagementId: otherEngagementId,
      roomId: r2.id,
      startsOn: '2032-02-01',
      endsOn: '2032-03-15',
    })
    const occ = await asCm().housing.occupancy({ from: '2032-02-01', days: 14 })
    expect(occ.warnings.map((w) => w.kind)).toContain('private_bathroom')

    // A room with someone in it can't be removed out from under them.
    await expect(asCm().housing.removeRoom({ id: r1.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('Move them first'),
    })
  })

  it('two saves at once can’t give one person overlapping stays in different rooms', async () => {
    const unit = await asCm().housing.createUnit({ name: `Race house ${tag}`, kind: 'apartment' })
    units.push(unit.id)
    const a = await asCm().housing.addRoom({ unitId: unit.id, name: 'A', floor: 1, bathroom: 'A bath' })
    const b = await asCm().housing.addRoom({ unitId: unit.id, name: 'B', floor: 1, bathroom: 'B bath' })
    const stay = { engagementId, startsOn: '2032-04-01', endsOn: '2032-04-05' }
    const results = await Promise.allSettled([
      asCm().housing.assign({ ...stay, roomId: a.id }),
      asCm().housing.assign({ ...stay, roomId: b.id }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } })

    // The database refuses it too, even for a write that skips the app's check.
    await expect(
      db.insert(housingAssignment).values({ ...stay, roomId: b.id, startsOn: '2032-04-03' }),
    ).rejects.toMatchObject({ cause: { code: '23P01' } })
  })
})
