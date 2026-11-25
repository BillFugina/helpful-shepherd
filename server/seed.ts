import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import { DEFAULT_GRANTS, ROLES, type Role } from '../shared/access.js'
import { encryptOptional } from './crypto/fields.js'
import type { Db } from './db/client.js'
import { account, person, roleGrant, user, userRole } from './db/schema.js'

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
] as const

/** Replaces the demo people, leaving any person not marked as demo alone. */
export async function reseedDemoPeople(db: Db, key?: Buffer): Promise<number> {
  await db.delete(person).where(eq(person.isDemo, true))
  const rows = DEMO_PEOPLE.map((p, i) => {
    const n = String(i + 1).padStart(2, '0')
    const slug = p.legalName.toLowerCase().replace(/[^a-z]+/g, '.')
    return {
      legalName: p.legalName,
      preferredName: p.preferredName,
      email: `${slug}@example.com`,
      cell: `919-555-01${n}`,
      homeAirport: p.homeAirport,
      dobEnc: encryptOptional(p.dob, 'person.dob', key),
      tsaKtnEnc: encryptOptional(p.tsaKtn, 'person.tsa_ktn', key),
      frequentFlyerEnc: encryptOptional(i % 3 === 0 ? `DEMO-FF-${n}` : null, 'person.frequent_flyer', key),
      isDemo: true,
    }
  })
  await db.insert(person).values(rows)
  return rows.length
}
