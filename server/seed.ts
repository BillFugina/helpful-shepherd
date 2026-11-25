import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { eq, inArray, or } from 'drizzle-orm'
import { DEFAULT_GRANTS, ROLES, type Role } from '../shared/access.js'
import { encryptOptional } from './crypto/fields.js'
import type { Db } from './db/client.js'
import {
  account,
  agent,
  conflict,
  engagement,
  person,
  production,
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

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface DemoCounts {
  people: number
  agents: number
  seasons: number
  productions: number
  engagements: number
  conflicts: number
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
      .values(DEMO_PRODUCTIONS.map((p) => ({ ...p, seasonId: s!.id, performanceSchedule: SCHEDULE, isDemo: true })))
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

    return {
      people: people.length,
      agents: agents.length,
      seasons: 1,
      productions: productions.length,
      engagements: engagements.length,
      conflicts: conflictRows.length,
    }
  })
}
