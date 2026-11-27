import { randomUUID } from 'node:crypto'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { encryptField, fieldKey } from '../server/crypto/fields.js'
import { createDb, type Db } from '../server/db/client.js'
import { auditEvent, person, roleGrant, user, userRole } from '../server/db/schema.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import type { Role } from '../shared/access.js'

const createCaller = createCallerFactory(appRouter)
const noDb = new Proxy({} as Db, {
  get() {
    throw new Error('this test should not touch the database')
  },
})

function fakeUser(over: Partial<SessionUser> = {}): SessionUser {
  const id = `test-${randomUUID()}`
  return { id, email: `${id}@example.com`, name: 'Tester', twoFactorEnabled: true, ...over }
}

describe('without a database', () => {
  it('me is null when signed out', async () => {
    expect(await createCaller({ db: noDb, user: null }).me()).toBeNull()
  })

  it('data calls reject callers without a session', async () => {
    await expect(createCaller({ db: noDb, user: null }).people.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('data calls reject a signed-in user until two-factor is on', async () => {
    const caller = createCaller({ db: noDb, user: fakeUser({ twoFactorEnabled: false }) })
    await expect(caller.people.list()).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'TWO_FACTOR_REQUIRED' })
    await expect(caller.audit.list({})).rejects.toMatchObject({ message: 'TWO_FACTOR_REQUIRED' })
  })
})

// Runs only when a migrated database is available (CI provides one; locally,
// set DATABASE_URL to a disposable database and run `npm run db:migrate`).
const url = process.env.DATABASE_URL
describe.skipIf(!url)('against Postgres', () => {
  const db = url ? createDb(url) : noDb
  const cm = fakeUser()
  const finance = fakeUser()
  const noRole = fakeUser()
  let personId = ''

  async function addUser(u: SessionUser, role?: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    if (role) await db.insert(userRole).values({ userId: u.id, role })
  }

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(finance, 'finance_manager')
    await addUser(noRole)
    const key = fieldKey()
    const [p] = await db
      .insert(person)
      .values({
        legalName: `Test Person ${randomUUID()}`,
        email: 'test.person@example.com',
        dobEnc: encryptField('1990-01-02', 'person.dob', key),
        tsaKtnEnc: encryptField('TT9999999', 'person.tsa_ktn', key),
      })
      .returning({ id: person.id })
    personId = p!.id
  })

  afterAll(async () => {
    await db.delete(user).where(inArray(user.id, [cm.id, finance.id, noRole.id]))
    await db.delete(person).where(eq(person.id, personId))
  })

  it('me reports the role and grants', async () => {
    const me = await createCaller({ db, user: finance }).me()
    expect(me?.role).toBe('finance_manager')
    expect(me?.grants.tax_bank).toBe('review')
  })

  it('a user with no role sees nothing', async () => {
    await expect(createCaller({ db, user: noRole }).people.list()).rejects.toMatchObject({ message: 'NO_ROLE' })
  })

  it('lists people with sensitive values masked and ungranted groups dropped', async () => {
    const asFinance = (await createCaller({ db, user: finance }).people.list()).find((p) => p.id === personId)
    expect(asFinance?.email).toBe('test.person@example.com')
    expect(asFinance?.dob).toEqual({ masked: true, hasValue: true })
    expect(asFinance && 'tsaKtn' in asFinance).toBe(false)

    const asCm = (await createCaller({ db, user: cm }).people.list()).find((p) => p.id === personId)
    expect(asCm?.tsaKtn).toEqual({ masked: true, hasValue: true })
    expect(JSON.stringify(asCm)).not.toContain('TT9999999')
  })

  it('reveal returns the value and writes an audit event', async () => {
    const result = await createCaller({ db, user: cm }).people.reveal({ personId, field: 'tsaKtn' })
    expect(result.value).toBe('TT9999999')
    const events = await db.select().from(auditEvent).where(eq(auditEvent.actorId, cm.id))
    expect(events).toEqual([
      expect.objectContaining({ action: 'reveal', personId, fieldGroup: 'travel_id', detail: { field: 'tsaKtn' } }),
    ])
    expect(JSON.stringify(events)).not.toContain('TT9999999')
  })

  it('reveal rejects bad input', async () => {
    await expect(
      createCaller({ db, user: cm }).people.reveal({ personId: 'nope', field: 'dob' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('reveal refuses a group the role has no grant for', async () => {
    await expect(
      createCaller({ db, user: finance }).people.reveal({ personId, field: 'tsaKtn' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('admin screens are Company Manager only', async () => {
    const asFinance = createCaller({ db, user: finance })
    await expect(asFinance.audit.list({})).rejects.toMatchObject({ message: 'ADMIN_ONLY' })
    await expect(asFinance.access.matrix()).rejects.toMatchObject({ message: 'ADMIN_ONLY' })
  })

  it('the audit log filters by person', async () => {
    const rows = await createCaller({ db, user: cm }).audit.list({ personId })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.personId === personId)).toBe(true)
  })

  it('granting travel IDs needs a second confirmation, and the change is logged', async () => {
    const asCm = createCaller({ db, user: cm })
    const input = { role: 'finance_manager', fieldGroup: 'travel_id', level: 'view' } as const
    await expect(asCm.access.setGrant(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    try {
      expect(await asCm.access.setGrant({ ...input, confirmSensitive: true })).toEqual({ changed: true })
      expect((await asCm.access.matrix()).finance_manager.travel_id).toBe('view')
      const reveal = await createCaller({ db, user: finance }).people.reveal({ personId, field: 'tsaKtn' })
      expect(reveal.value).toBe('TT9999999')
    } finally {
      await asCm.access.setGrant({ ...input, level: 'none' })
    }
    const [row] = await db
      .select()
      .from(roleGrant)
      .where(sql`role = 'finance_manager' and field_group = 'travel_id'`)
    expect(row).toBeUndefined()
    const changes = await db.select().from(auditEvent).where(eq(auditEvent.actorId, cm.id))
    expect(changes.filter((e) => e.action === 'grant_change').map((e) => e.detail)).toEqual([
      { role: 'finance_manager', from: 'none', to: 'view', confirmed: true },
      { role: 'finance_manager', from: 'view', to: 'none', confirmed: false },
    ])
  })

  it('concurrent grant changes are serialized, so the log records each real previous value', async () => {
    const asCm = createCaller({ db, user: cm })
    const base = { role: 'finance_manager', fieldGroup: 'travel_logistics' } as const
    const levels = ['view', 'review', 'edit', 'none'] as const
    try {
      await Promise.all(
        Array.from({ length: 16 }, (_, i) => asCm.access.setGrant({ ...base, level: levels[i % 4] ?? 'none' })),
      )
      const events = await db
        .select()
        .from(auditEvent)
        .where(sql`${auditEvent.actorId} = ${cm.id} and ${auditEvent.recordId} = 'finance_manager:travel_logistics'`)
        .orderBy(asc(auditEvent.at))
      const steps = events.map((e) => e.detail as { from: string; to: string })
      expect(steps.length).toBeGreaterThan(0)
      expect(steps[0]?.from).toBe('none')
      for (let i = 1; i < steps.length; i++) expect(steps[i]?.from).toBe(steps[i - 1]?.to)
      expect((await asCm.access.matrix()).finance_manager.travel_logistics ?? 'none').toBe(steps.at(-1)?.to)
    } finally {
      await asCm.access.setGrant({ ...base, level: 'none' })
    }
  })

  it("can't change the Company Manager's own grants", async () => {
    await expect(
      createCaller({ db, user: cm }).access.setGrant({ role: 'company_manager', fieldGroup: 'general', level: 'view' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('alert credits: the Company Manager can read and top them up, and the top-up is logged', async () => {
    const sent: { url: string; body: unknown }[] = []
    vi.stubEnv('AERODATABOX_API_KEY', 'test-key')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return Response.json({ creditsRemaining: url.endsWith('/refill') ? 100 : 0 })
    })
    try {
      const asCm = createCaller({ db, user: cm })
      expect(await asCm.arrivals.alertCredits()).toEqual({ available: true, credits: 0, error: false })
      expect(await asCm.arrivals.topUpCredits({ credits: 100 })).toEqual({ credits: 100 })
      expect(sent.at(-1)).toEqual({
        url: 'https://api.aerodatabox.com/subscriptions/balance/refill',
        body: { credits: 100 },
      })
      const [event] = await db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.recordType, 'flight_credits'))
        .orderBy(sql`${auditEvent.at} desc`)
        .limit(1)
      expect(event).toMatchObject({ actorId: cm.id, action: 'update', detail: { added: 100 } })
      // Only the listed amounts, and only the Company Manager.
      await expect(asCm.arrivals.topUpCredits({ credits: 5000 as 100 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await expect(createCaller({ db, user: finance }).arrivals.topUpCredits({ credits: 50 })).rejects.toMatchObject({
        message: 'ADMIN_ONLY',
      })
      const refills = sent.filter((c) => c.url.endsWith('/refill'))
      expect(refills).toHaveLength(1)
      // A refused top-up says why it might have failed.
      fetchSpy.mockImplementation(async () => new Response('no', { status: 400 }))
      await expect(asCm.arrivals.topUpCredits({ credits: 50 })).rejects.toMatchObject({ code: 'BAD_GATEWAY' })
      expect(await asCm.arrivals.alertCredits()).toEqual({ available: true, credits: null, error: true })
    } finally {
      fetchSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('the audit log refuses updates and deletes', async () => {
    await expect(db.update(auditEvent).set({ via: 'x' }).where(eq(auditEvent.actorId, cm.id))).rejects.toThrow()
    await expect(db.delete(auditEvent).where(eq(auditEvent.actorId, cm.id))).rejects.toThrow()
  })
})
