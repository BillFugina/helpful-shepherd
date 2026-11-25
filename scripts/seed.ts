/**
 * Seeds a demo database: the default grants, two demo staff logins and a
 * clearly fake roster (people, agents, a season, productions, engagements).
 * Safe to run again; it replaces only demo rows.
 *
 *   npm run db:seed
 *
 * Env (see .env.example): DATABASE_URL, FIELD_ENCRYPTION_KEY, and optionally
 * SEED_CM_EMAIL, SEED_FINANCE_EMAIL and SEED_DEMO_PASSWORD. Without a password,
 * one is generated and printed once.
 */
import { randomBytes } from 'node:crypto'
import { createDb } from '../server/db/client.js'
import { ensureDefaultGrants, reseedDemo, upsertStaff } from '../server/seed.js'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('[seed] DATABASE_URL is required.')
  process.exit(1)
}
const db = createDb(url)

const generated = !process.env.SEED_DEMO_PASSWORD
const password = process.env.SEED_DEMO_PASSWORD ?? randomBytes(12).toString('base64url')
if (password.length < 12) {
  console.error('[seed] SEED_DEMO_PASSWORD must be at least 12 characters.')
  process.exit(1)
}

const staff = [
  {
    email: process.env.SEED_CM_EMAIL ?? 'company.manager@example.com',
    name: 'Demo Company Manager',
    role: 'company_manager' as const,
  },
  {
    email: process.env.SEED_FINANCE_EMAIL ?? 'finance@example.com',
    name: 'Demo Finance Manager',
    role: 'finance_manager' as const,
  },
]

const grants = await ensureDefaultGrants(db)
console.info(`[seed] default grants: ${grants.length ? grants.join(', ') : 'already set, left as they are'}`)
for (const s of staff) {
  console.info(`[seed] ${s.role}: ${s.email} (${await upsertStaff(db, s, password)})`)
}
const counts = await reseedDemo(db)
console.info(
  `[seed] demo roster: ${counts.people} people, ${counts.agents} agents, ${counts.productions} productions, ${counts.engagements} engagements, ${counts.conflicts} conflicts`,
)
if (generated) {
  console.info(`[seed] demo password (shown once, not stored anywhere): ${password}`)
}
console.info('[seed] each login sets up two-factor on first sign-in.')
process.exit(0)
