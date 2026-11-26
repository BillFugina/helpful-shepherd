import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { eq, inArray, or } from 'drizzle-orm'
import { DEFAULT_GRANTS, ROLES, type Role } from '../shared/access.js'
import { DEFAULT_RIDER_BODY, resolveContract, type ContractContext } from '../shared/contracts.js'
import { makeStandInForm } from './contracts/pdf.js'
import { loadOrganization, valuesToFreeze } from './contracts/service.js'
import { airportTz, THEATRE_AIRPORT, THEATRE_TZ, zonedToUtc } from '../shared/time.js'
import { encryptOptional } from './crypto/fields.js'
import type { Db } from './db/client.js'
import {
  account,
  agent,
  conflict,
  contract,
  contractTemplate,
  engagement,
  flight,
  housingAssignment,
  housingPreference,
  housingRoom,
  housingUnit,
  organization,
  person,
  production,
  rentalCar,
  roleGrant,
  season,
  user,
  userRole,
} from './db/schema.js'
import { PERSON_STORAGE } from './registry/person.js'

/**
 * Gives each role the plan's default grants, but only a role that has none
 * yet, so a reseed never undoes changes the Company Manager made.
 */
export async function ensureDefaultGrants(db: Db): Promise<Role[]> {
  const seeded: Role[] = []
  for (const role of ROLES) {
    const existing = await db.select({ role: roleGrant.role }).from(roleGrant).where(eq(roleGrant.role, role)).limit(1)
    if (existing.length) continue
    const rows = Object.entries(DEFAULT_GRANTS[role]).map(([fieldGroup, level]) => ({
      role,
      fieldGroup: fieldGroup as keyof typeof DEFAULT_GRANTS.company_manager,
      level: level!,
    }))
    if (rows.length) await db.insert(roleGrant).values(rows).onConflictDoNothing()
    seeded.push(role)
  }
  return seeded
}

export interface StaffSeed {
  email: string
  name: string
  role: Role
}

/**
 * Creates a staff login with a password, or resets the password and role of an
 * existing one. Two-factor starts off: the person sets it up on first sign-in,
 * and the app shows them nothing until they do.
 */
export async function upsertStaff(db: Db, staff: StaffSeed, password: string): Promise<'created' | 'updated'> {
  const email = staff.email.toLowerCase()
  const hash = await hashPassword(password)
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)
  const userId = existing?.id ?? randomUUID()
  if (!existing) {
    await db.insert(user).values({ id: userId, email, name: staff.name, emailVerified: true })
    await db.insert(account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: 'credential',
      password: hash,
    })
  } else {
    await db.update(account).set({ password: hash }).where(eq(account.userId, userId))
  }
  await db
    .insert(userRole)
    .values({ userId, role: staff.role })
    .onConflictDoUpdate({ target: userRole.userId, set: { role: staff.role } })
  return existing ? 'updated' : 'created'
}

/** Clearly fake people: example.com emails, 555-01xx numbers, made-up IDs. */
export const DEMO_PEOPLE = [
  { legalName: 'Avery Castellano', preferredName: 'Avery', homeAirport: 'LGA', dob: '1988-03-14', tsaKtn: 'TT0000101' },
  { legalName: 'Jordan Okafor', preferredName: null, homeAirport: 'JFK', dob: '1992-07-02', tsaKtn: null },
  { legalName: 'Marisol Vance', preferredName: 'Mari', homeAirport: 'ORD', dob: '1979-11-23', tsaKtn: 'TT0000102' },
  { legalName: 'Theo Lindqvist', preferredName: null, homeAirport: 'BOS', dob: '1995-01-30', tsaKtn: null },
  { legalName: 'Priya Ramanathan', preferredName: null, homeAirport: 'LAX', dob: '1986-05-09', tsaKtn: 'TT0000103' },
  { legalName: 'Desmond Achebe-Hart', preferredName: 'Dez', homeAirport: 'ATL', dob: '1990-09-17', tsaKtn: null },
  { legalName: 'Celeste Moreau', preferredName: null, homeAirport: 'RDU', dob: '1983-12-04', tsaKtn: null },
  { legalName: 'Felix Navarro', preferredName: null, homeAirport: 'EWR', dob: '1998-04-21', tsaKtn: 'TT0000104' },
  { legalName: 'Harper Quinlan', preferredName: null, homeAirport: 'DCA', dob: '1975-08-11', tsaKtn: null },
  { legalName: 'Isabela Ferreira', preferredName: 'Bela', homeAirport: 'MIA', dob: '1993-02-27', tsaKtn: 'TT0000105' },
  { legalName: 'Kenji Watanabe-Price', preferredName: null, homeAirport: 'SEA', dob: '1989-06-15', tsaKtn: null },
  { legalName: 'Rosalind Mbeki', preferredName: 'Roz', homeAirport: 'PHL', dob: '1981-10-08', tsaKtn: null },
  { legalName: 'Silas Thornbury', preferredName: null, homeAirport: 'CLT', dob: '1987-01-19', tsaKtn: null },
  { legalName: 'Noor El-Amin', preferredName: null, homeAirport: 'IAD', dob: '1994-08-30', tsaKtn: 'TT0000106' },
  { legalName: 'Beatrix Halloran', preferredName: 'Bea', homeAirport: 'MSP', dob: '1980-04-05', tsaKtn: null },
  { legalName: 'Mateo Gutierrez-Lowe', preferredName: null, homeAirport: 'DEN', dob: '1996-11-12', tsaKtn: null },
  { legalName: 'Opal Whitcombe', preferredName: null, homeAirport: 'RDU', dob: '1972-06-23', tsaKtn: null },
  { legalName: 'Rafferty Osei', preferredName: 'Raff', homeAirport: 'BNA', dob: '1991-03-03', tsaKtn: 'TT0000107' },
  { legalName: 'Tamsin Delacroix', preferredName: null, homeAirport: 'SFO', dob: '1985-09-28', tsaKtn: null },
  { legalName: 'Wendell Abernathy', preferredName: 'Wen', homeAirport: 'PIT', dob: '1977-12-16', tsaKtn: null },
] as const

/** Made-up agents at made-up agencies. */
export const DEMO_AGENTS = [
  { name: 'Lena Brightwater', agency: 'Example Talent Group', phone: '212-555-0181' },
  { name: 'Marcus Feld', agency: 'Sample Artists Agency', phone: '212-555-0182' },
  { name: 'Ruth Calloway', agency: 'Placeholder Management', phone: '323-555-0183' },
  { name: 'Dev Anand-Rossi', agency: 'Example Talent Group', phone: '212-555-0184' },
] as const

const SCHEDULE = 'Wed to Sat 7:30 PM, Sun 2:00 PM. Added Sat matinee closing week.'

/** Invented titles, so the demo never looks like a real season's casting. */
export const DEMO_PRODUCTIONS = [
  {
    title: 'The Lighthouse Choir',
    rehearsalStart: '2027-01-11',
    techStart: '2027-01-25',
    opening: '2027-01-30',
    closing: '2027-02-14',
  },
  {
    title: 'Twelve Lanterns',
    rehearsalStart: '2027-03-08',
    techStart: '2027-03-22',
    opening: '2027-03-27',
    closing: '2027-04-11',
  },
  {
    title: 'Mabel and the Moon Machine',
    rehearsalStart: '2027-05-10',
    techStart: '2027-05-24',
    opening: '2027-05-29',
    closing: '2027-06-13',
  },
  {
    title: 'A Summer at Pine Hollow',
    rehearsalStart: '2027-07-12',
    techStart: '2027-07-26',
    opening: '2027-07-31',
    closing: '2027-08-15',
  },
  {
    title: 'The Last Ferry Home',
    rehearsalStart: '2027-10-04',
    techStart: '2027-10-18',
    opening: '2027-10-23',
    closing: '2027-11-07',
  },
] as const

/** Five slots per production: role, contract type, base weekly pay in dollars. */
const SLOTS = [
  { role: 'Director', contractType: 'sdc', pay: 1500 },
  { role: 'Choreographer', contractType: 'sdc', pay: 1200 },
  { role: 'Lead', contractType: 'equity_itc', pay: 1050 },
  { role: 'Supporting', contractType: 'equity_itc', pay: 900 },
  { role: 'Music Director', contractType: 'non_union', pay: 850 },
] as const

/** Earlier productions are further along the pipeline. */
const STATUS_BY_PRODUCTION = [
  ['arrived', 'arrived', 'travel_booked', 'arrived', 'paperwork_complete'],
  ['travel_booked', 'paperwork_complete', 'contract_signed', 'travel_booked', 'contract_signed'],
  ['contract_signed', 'contract_sent', 'contract_signed', 'contract_sent', 'offer_accepted'],
  ['contract_sent', 'offer_accepted', 'offer_accepted', 'contract_sent', 'offer_accepted'],
  ['offer_accepted', 'offer_accepted', 'offer_accepted', 'offer_accepted', 'offer_accepted'],
] as const

/** Made-up home addresses by home airport. Person 19 has none, to show a blank field. */
const DEMO_CITIES: Record<string, string> = {
  LGA: 'New York, NY 10025',
  JFK: 'Brooklyn, NY 11215',
  ORD: 'Chicago, IL 60614',
  BOS: 'Boston, MA 02118',
  LAX: 'Los Angeles, CA 90026',
  ATL: 'Atlanta, GA 30307',
  RDU: 'Raleigh, NC 27605',
  EWR: 'Newark, NJ 07102',
  DCA: 'Washington, DC 20009',
  MIA: 'Miami, FL 33137',
  SEA: 'Seattle, WA 98122',
  PHL: 'Philadelphia, PA 19147',
  CLT: 'Charlotte, NC 28203',
  IAD: 'Arlington, VA 22201',
  MSP: 'Minneapolis, MN 55408',
  DEN: 'Denver, CO 80206',
  BNA: 'Nashville, TN 37206',
  SFO: 'San Francisco, CA 94110',
  PIT: 'Pittsburgh, PA 15213',
}
const NO_ADDRESS = 18

/** The theatre's details on the demo's contracts. Every number is fake. */
export const DEMO_ORGANIZATION = {
  name: 'Theatre Raleigh (demo)',
  street: '100 Example Street',
  cityStateZip: 'Raleigh, NC 27601',
  phone: '919-555-0100',
  email: 'company.manager@example.com',
  signerName: 'Pat Example',
  ein: '00-0000000',
  unemploymentNumber: 'DEMO-000000',
  equityEmployerAgreement: 'DEMO-ITC-0000',
}

const DEMO_VENUE = {
  venueName: 'Main Stage (demo)',
  venueCapacity: 280,
  topTicketCents: 6500,
  scheduledPerformances: 20,
  rehearsalLocation: 'Rehearsal Hall (demo), 100 Example Street, Raleigh',
  rehearsalCallTime: '10:00 AM',
}

/** SDC directors and choreographers are paid a flat fee, in dollars. */
const SDC_FEES: Record<string, number> = { Director: 8000, Choreographer: 6000 }

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Made-up flights home to the theater. The airline codes are real so the
 * board reads naturally, but the numbers are invented and the feed is
 * simulated. The last digit picks what the feed does (see flights/provider.ts).
 */
const DEMO_ROUTES: Record<string, { airline: string; minutes: number }> = {
  LGA: { airline: 'DL', minutes: 105 },
  JFK: { airline: 'B6', minutes: 110 },
  ORD: { airline: 'AA', minutes: 125 },
  BOS: { airline: 'B6', minutes: 130 },
  LAX: { airline: 'AA', minutes: 290 },
  ATL: { airline: 'DL', minutes: 85 },
  EWR: { airline: 'UA', minutes: 105 },
  DCA: { airline: 'AA', minutes: 70 },
  MIA: { airline: 'AA', minutes: 125 },
  SEA: { airline: 'AS', minutes: 330 },
  PHL: { airline: 'AA', minutes: 85 },
  CLT: { airline: 'AA', minutes: 55 },
  IAD: { airline: 'UA', minutes: 70 },
  MSP: { airline: 'DL', minutes: 160 },
  DEN: { airline: 'UA', minutes: 220 },
  BNA: { airline: 'WN', minutes: 95 },
  SFO: { airline: 'UA', minutes: 315 },
  PIT: { airline: 'WN', minutes: 85 },
}
/** Departure times at the home airport (arriving) and at RDU (going home), by slot. */
const ARRIVE_DEPARTS = ['07:10', '09:25', '11:40', '13:15', '16:05'] as const
const HOME_DEPARTS = ['10:20', '12:45', '08:30', '15:10', '17:35'] as const
/**
 * Last digit of each arriving flight, by production and slot. The first
 * production's arrival day (Jan 10, 2027) has a 45-minute delay, a gate
 * change and an early landing; the second has a cancellation.
 */
const ARRIVAL_DIGITS = [
  [7, 8, 3, 1, 2],
  [5, 4, 0, 9, 6],
  [2, 3, 7, 0, 8],
  [1, 6, 4, 5, 0],
  [0, 2, 8, 6, 3],
] as const
const RETURN_DIGITS = [2, 5, 6, 8, 0] as const

/** Places to stay, all invented. Rooms sharing a bathroom label share that bathroom. */
const DEMO_HOUSING = [
  {
    name: 'Company house (demo)',
    kind: 'company_house' as const,
    address: '100 Example Lane, Raleigh, NC',
    accessNotes: 'Lockbox by the side door. Park on the street (demo).',
    doorCode: '0000',
    rooms: [
      { name: 'Room 1', floor: 1, bathroom: 'Downstairs bath' },
      { name: 'Room 2', floor: 1, bathroom: 'Downstairs bath' },
      { name: 'Room 3', floor: 2, bathroom: 'Upstairs bath' },
      { name: 'Room 4', floor: 2, bathroom: 'Upstairs bath' },
    ],
  },
  {
    name: 'Glenwood apartment (demo)',
    kind: 'apartment' as const,
    address: '200 Sample Street, Apt 3B, Raleigh, NC',
    accessNotes: 'Key fob at the theater front desk (demo).',
    doorCode: null,
    rooms: [{ name: 'Bedroom', floor: 3, bathroom: 'Private bath' }],
  },
  {
    name: 'Oakwood guesthouse (demo, donated)',
    kind: 'guesthouse' as const,
    address: '300 Placeholder Road, Raleigh, NC',
    accessNotes: 'Host lives in the main house. Text before arriving late (demo).',
    doorCode: '1111',
    rooms: [
      { name: 'Front bedroom', floor: 1, bathroom: 'Guest bath' },
      { name: 'Back bedroom', floor: 1, bathroom: 'Guest bath' },
    ],
  },
] as const

/** Housing rules, by person index. Set so the second production shows warnings. */
const DEMO_PREFERENCES = [
  { at: 4, rule: 'private_bathroom' as const, note: 'Asked for her own bathroom (demo).' },
  { at: 8, rule: 'ground_floor' as const, note: 'Prefers no stairs (demo).' },
]

export interface DemoCounts {
  people: number
  agents: number
  seasons: number
  productions: number
  engagements: number
  conflicts: number
  contracts: number
  flights: number
  cars: number
  housingUnits: number
  rooms: number
  stays: number
}

/**
 * Replaces every demo row: people, agents, a season, its productions, the
 * engagements and their conflicts. Rows not marked as demo are left alone,
 * except an engagement that points at a demo person or production, which has
 * to go with them.
 */
export async function reseedDemo(db: Db, key?: Buffer): Promise<DemoCounts> {
  return db.transaction(async (tx) => {
    const demoPeople = tx.select({ id: person.id }).from(person).where(eq(person.isDemo, true))
    const demoProductions = tx.select({ id: production.id }).from(production).where(eq(production.isDemo, true))
    const demoRooms = tx
      .select({ id: housingRoom.id })
      .from(housingRoom)
      .innerJoin(housingUnit, eq(housingUnit.id, housingRoom.unitId))
      .where(eq(housingUnit.isDemo, true))
    // Flights, cars and stays go with their engagements; stays in demo rooms go first.
    await tx.delete(housingAssignment).where(inArray(housingAssignment.roomId, demoRooms))
    await tx.delete(housingUnit).where(eq(housingUnit.isDemo, true))
    // Contracts go with their engagements, but any made from a demo template go first.
    const demoTemplates = tx
      .select({ id: contractTemplate.id })
      .from(contractTemplate)
      .where(eq(contractTemplate.isDemo, true))
    await tx.delete(contract).where(or(eq(contract.isDemo, true), inArray(contract.templateId, demoTemplates)))
    await tx.delete(contractTemplate).where(eq(contractTemplate.isDemo, true))
    await tx
      .delete(engagement)
      .where(
        or(
          eq(engagement.isDemo, true),
          inArray(engagement.personId, demoPeople),
          inArray(engagement.productionId, demoProductions),
        ),
      )
    await tx.delete(production).where(eq(production.isDemo, true))
    await tx.delete(season).where(eq(season.isDemo, true))
    await tx.delete(agent).where(eq(agent.isDemo, true))
    await tx.delete(person).where(eq(person.isDemo, true))

    const people = await tx
      .insert(person)
      .values(
        DEMO_PEOPLE.map((p, i) => {
          const n = String(i + 1).padStart(2, '0')
          const slug = p.legalName.toLowerCase().replace(/[^a-z]+/g, '.')
          return {
            legalName: p.legalName,
            preferredName: p.preferredName,
            email: `${slug}@example.com`,
            cell: `919-555-01${n}`,
            homeAirport: p.homeAirport,
            airportPrefs: i % 4 === 0 ? 'Prefers morning nonstops.' : null,
            dobEnc: encryptOptional(p.dob, PERSON_STORAGE.dob.aad, key),
            tsaKtnEnc: encryptOptional(p.tsaKtn, PERSON_STORAGE.tsaKtn.aad, key),
            frequentFlyerEnc: encryptOptional(
              i % 3 === 0 ? `DEMO-FF-${n}` : null,
              PERSON_STORAGE.frequentFlyer.aad,
              key,
            ),
            unionMemberId: `DEMO-${n}`,
            homeStreetEnc: encryptOptional(
              i === NO_ADDRESS ? null : `${100 + i * 7} Example Avenue`,
              PERSON_STORAGE.homeStreet.aad,
              key,
            ),
            homeCityStateZipEnc: encryptOptional(
              i === NO_ADDRESS ? null : (DEMO_CITIES[p.homeAirport] ?? null),
              PERSON_STORAGE.homeCityStateZip.aad,
              key,
            ),
            isDemo: true,
          }
        }),
      )
      .returning({ id: person.id })

    const agents = await tx
      .insert(agent)
      .values(
        DEMO_AGENTS.map((a) => ({
          ...a,
          email: `${a.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
          isDemo: true,
        })),
      )
      .returning({ id: agent.id })

    const [s] = await tx
      .insert(season)
      .values({
        name: '2027 Season (demo)',
        program: 'main_stage',
        startsOn: '2027-01-01',
        endsOn: '2027-12-31',
        isDemo: true,
      })
      .returning({ id: season.id })

    const productions = await tx
      .insert(production)
      .values(
        DEMO_PRODUCTIONS.map((p) => ({
          ...p,
          ...DEMO_VENUE,
          seasonId: s!.id,
          performanceSchedule: SCHEDULE,
          isDemo: true,
        })),
      )
      .returning({ id: production.id })

    // 25 deals for 20 people: production k takes people 4k..4k+4, so the
    // fifth person of each production comes back for the next one.
    const engagementRows = productions.flatMap((prod, k) =>
      SLOTS.map((slot, j) => {
        const pi = (k * 4 + j) % DEMO_PEOPLE.length
        const local = DEMO_PEOPLE[pi]!.homeAirport === 'RDU'
        const agentIndex = slot.contractType === 'non_union' ? null : (pi + k) % DEMO_AGENTS.length
        const dates = DEMO_PRODUCTIONS[k]!
        return {
          personId: people[pi]!.id,
          productionId: prod.id,
          agentId: agentIndex === null ? null : agents[agentIndex]!.id,
          role: slot.role,
          contractType: slot.contractType,
          pipelineStatus: STATUS_BY_PRODUCTION[k]![j]!,
          weeklyPayCents: (slot.pay + ((pi * 25) % 150)) * 100,
          feeCents: SDC_FEES[slot.role] ? SDC_FEES[slot.role]! * 100 : null,
          commissionPercent: agentIndex === null ? null : 10,
          weeklyStipendCents: local ? null : 25000,
          travelProvided: !local,
          carProvided: !local && j !== 4,
          housingProvided: !local,
          preferredArrival: local ? null : addDays(dates.rehearsalStart, -1),
          preferredDeparture: local ? null : addDays(dates.closing, 1),
          scriptNeeded: j >= 2,
          compAllotment: 2,
          isDemo: true,
        }
      }),
    )
    const engagements = await tx.insert(engagement).values(engagementRows).returning({ id: engagement.id })

    const conflictRows = [
      { at: 2, startsOn: '2027-01-18', endsOn: '2027-01-19', description: 'Callback in New York (demo)' },
      { at: 8, startsOn: '2027-03-15', endsOn: '2027-03-15', description: 'Sister’s wedding (demo)' },
      { at: 13, startsOn: '2027-05-17', endsOn: '2027-05-18', description: 'Recording session (demo)' },
      { at: 19, startsOn: '2027-07-20', endsOn: '2027-07-20', description: 'Family event, morning only (demo)' },
    ]
    await tx.insert(conflict).values(conflictRows.map(({ at, ...c }) => ({ ...c, engagementId: engagements[at]!.id })))

    const contractCount = await seedContracts(tx, {
      productions: DEMO_PRODUCTIONS.map((p) => ({ ...p, ...DEMO_VENUE })),
      seasonName: '2027 Season (demo)',
      engagements: engagementRows.map((e, i) => ({ ...e, id: engagements[i]!.id })),
    })

    // Travel, cars and housing for everyone the theater brings in.
    const units = await tx
      .insert(housingUnit)
      .values(DEMO_HOUSING.map(({ rooms: _rooms, ...u }) => ({ ...u, isDemo: true })))
      .returning({ id: housingUnit.id })
    const rooms = await tx
      .insert(housingRoom)
      .values(DEMO_HOUSING.flatMap((u, i) => u.rooms.map((r) => ({ ...r, unitId: units[i]!.id }))))
      .returning({ id: housingRoom.id })

    const flightRows: (typeof flight.$inferInsert)[] = []
    const carRows: (typeof rentalCar.$inferInsert)[] = []
    const stayRows: (typeof housingAssignment.$inferInsert)[] = []
    engagementRows.forEach((row, n) => {
      if (!row.travelProvided) return
      const k = Math.floor(n / SLOTS.length)
      const j = n % SLOTS.length
      const home = DEMO_PEOPLE[(k * 4 + j) % DEMO_PEOPLE.length]!.homeAirport
      const route = DEMO_ROUTES[home]!
      const engagementId = engagements[n]!.id
      const base = 2000 + n * 110
      const tag = String(n + 1).padStart(2, '0')

      const outLeaves = zonedToUtc(`${row.preferredArrival}T${ARRIVE_DEPARTS[j]}`, airportTz(home))
      const outLands = new Date(outLeaves.getTime() + route.minutes * 60_000)
      flightRows.push({
        engagementId,
        direction: 'arrival',
        airline: route.airline,
        flightNumber: String(base + ARRIVAL_DIGITS[k]![j]!),
        fromAirport: home,
        toAirport: THEATRE_AIRPORT,
        scheduledDeparture: outLeaves,
        scheduledArrival: outLands,
        confirmation: `DEMO${tag}A`,
        bookingSource: 'Booked by the theater (demo)',
      })
      const backLeaves = zonedToUtc(`${row.preferredDeparture}T${HOME_DEPARTS[j]}`, THEATRE_TZ)
      const backLands = new Date(backLeaves.getTime() + route.minutes * 60_000)
      flightRows.push({
        engagementId,
        direction: 'departure',
        airline: route.airline,
        flightNumber: String(base + 50 + RETURN_DIGITS[j]!),
        fromAirport: THEATRE_AIRPORT,
        toAirport: home,
        scheduledDeparture: backLeaves,
        scheduledArrival: backLands,
        confirmation: `DEMO${tag}A`,
        bookingSource: 'Booked by the theater (demo)',
      })
      if (row.carProvided) {
        carRows.push({
          engagementId,
          company: 'Example Car Rental (demo)',
          confirmation: `DEMO-CAR-${tag}`,
          pickupAt: new Date(outLands.getTime() + 30 * 60_000),
          pickupPlace: 'RDU rental car center',
          returnAt: new Date(backLeaves.getTime() - 2 * 3_600_000),
          returnPlace: 'RDU rental car center',
        })
      }
      // Productions don't overlap, so each one fills the rooms from the top.
      const roomIndex = engagementRows.slice(k * SLOTS.length, n).filter((r) => r.housingProvided).length
      if (row.housingProvided && rooms[roomIndex]) {
        stayRows.push({
          engagementId,
          roomId: rooms[roomIndex].id,
          startsOn: row.preferredArrival!,
          // One stay ends a night early, to show the flies-home-after-housing warning.
          endsOn: k === 2 && j === 2 ? addDays(row.preferredDeparture!, -1) : row.preferredDeparture!,
        })
      }
    })
    await tx.insert(flight).values(flightRows)
    if (carRows.length) await tx.insert(rentalCar).values(carRows)
    if (stayRows.length) await tx.insert(housingAssignment).values(stayRows)
    await tx
      .insert(housingPreference)
      .values(DEMO_PREFERENCES.map(({ at, ...p }) => ({ ...p, personId: people[at]!.id })))

    return {
      people: people.length,
      agents: agents.length,
      seasons: 1,
      productions: productions.length,
      engagements: engagements.length,
      conflicts: conflictRows.length,
      contracts: contractCount,
      flights: flightRows.length,
      cars: carRows.length,
      housingUnits: units.length,
      rooms: rooms.length,
      stays: stayRows.length,
    }
  })
}

/** The contract a demo deal has reached, from its pipeline status. Nothing before the fourth production's offers. */
function demoContractStatus(k: number, status: string): 'draft' | 'sent' | 'signed' | null {
  if (status === 'offer_accepted') return k <= 3 ? 'draft' : null
  if (status === 'contract_sent') return 'sent'
  return 'signed'
}

/**
 * The theatre's details (only if none are saved), demo stand-ins for the two
 * union forms, a generic rider, and each demo deal's contracts as far along as
 * its pipeline status. Sent and signed contracts keep the values that went out.
 */
async function seedContracts(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  demo: {
    productions: ((typeof DEMO_PRODUCTIONS)[number] & typeof DEMO_VENUE)[]
    seasonName: string
    engagements: {
      id: string
      productionId: string
      role: string
      contractType: string
      pipelineStatus: string
      weeklyPayCents: number
      weeklyStipendCents: number | null
      feeCents: number | null
      personId: string
    }[]
  },
): Promise<number> {
  await tx
    .insert(organization)
    .values({ id: 1, ...DEMO_ORGANIZATION })
    .onConflictDoNothing()
  const employer = await loadOrganization(tx)

  const forms = [
    { name: 'Equity ITC contract (demo stand-in)', format: 'equity_itc_form', contractType: 'equity_itc' },
    { name: 'SDC agreement (demo stand-in)', format: 'sdc_form', contractType: 'sdc' },
  ] as const
  const templateRows = [
    ...(await Promise.all(
      forms.map(async (f) => {
        const id = randomUUID()
        return {
          id,
          familyId: id,
          name: f.name,
          format: f.format,
          contractType: f.contractType,
          version: 1,
          pdf: Buffer.from(await makeStandInForm(f.format)),
          fileName: `${f.format}-demo.pdf`,
          isDemo: true,
        }
      }),
    )),
    (() => {
      const id = randomUUID()
      return {
        id,
        familyId: id,
        name: 'Theatre Raleigh ITC rider (demo)',
        format: 'text' as const,
        contractType: 'equity_itc' as const,
        version: 1,
        body: DEFAULT_RIDER_BODY,
        isDemo: true,
      }
    })(),
  ]
  await tx.insert(contractTemplate).values(templateRows)

  const people = await tx
    .select({
      id: person.id,
      legalName: person.legalName,
      unionMemberId: person.unionMemberId,
      email: person.email,
      cell: person.cell,
    })
    .from(person)
    .where(eq(person.isDemo, true))
  const peopleById = new Map(people.map((p) => [p.id, p]))

  const rows: (typeof contract.$inferInsert)[] = []
  demo.engagements.forEach((e, i) => {
    const k = Math.floor(i / 5)
    const status = demoContractStatus(k, e.pipelineStatus)
    if (!status) return
    const prod = demo.productions[k]!
    const sentOn = addDays(prod.rehearsalStart, -60)
    const p = peopleById.get(e.personId)!
    const context: ContractContext = {
      today: sentOn,
      employer,
      person: { ...p, homeStreet: null, homeCityStateZip: null },
      engagement: {
        role: e.role,
        weeklyPayCents: e.weeklyPayCents,
        weeklyStipendCents: e.weeklyStipendCents,
        feeCents: e.feeCents,
      },
      production: {
        title: prod.title,
        rehearsalStart: prod.rehearsalStart,
        opening: prod.opening,
        closing: prod.closing,
        venueName: prod.venueName,
        venueCapacity: prod.venueCapacity,
        topTicketCents: prod.topTicketCents,
        scheduledPerformances: prod.scheduledPerformances,
        rehearsalLocation: prod.rehearsalLocation,
        rehearsalCallTime: prod.rehearsalCallTime,
      },
      season: { name: demo.seasonName },
    }
    for (const t of templateRows.filter((t) => t.contractType === e.contractType)) {
      const sent = status !== 'draft'
      rows.push({
        engagementId: e.id,
        templateId: t.id,
        templateFamilyId: t.familyId,
        status,
        sentOn: sent ? sentOn : null,
        sentAt: sent ? new Date(`${sentOn}T15:00:00Z`) : null,
        sentTo: sent ? 'Them and their agent (demo)' : null,
        sentValues: sent
          ? valuesToFreeze(resolveContract({ format: t.format, body: 'body' in t ? t.body : null }, context, {}))
          : null,
        signedOn: status === 'signed' ? addDays(sentOn, 9) : null,
        isDemo: true,
      })
    }
  })
  if (rows.length) await tx.insert(contract).values(rows)
  return rows.length
}
