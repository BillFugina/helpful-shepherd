import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../server/db/client.js'
import { agent, auditEvent, engagement, person, production, season, user, userRole } from '../server/db/schema.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants, reseedDemo } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import type { Role } from '../shared/access.js'

const createCaller = createCallerFactory(appRouter)

function fakeUser(): SessionUser {
  const id = `test-${randomUUID()}`
  return { id, email: `${id}@example.com`, name: 'Tester', twoFactorEnabled: true }
}

// Runs only when a migrated database is available (CI provides one).
const url = process.env.DATABASE_URL
describe.skipIf(!url)('roster against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const cm = fakeUser()
  const finance = fakeUser()
  const tag = randomUUID().slice(0, 8)
  const email = (name: string) => `${name}.${tag}@example.com`
  const seasons: string[] = []
  const people: string[] = []
  const agents: string[] = []
  let productionId = ''
  let seasonId = ''

  const asCm = () => createCaller({ db, user: cm })
  const asFinance = () => createCaller({ db, user: finance })

  async function addUser(u: SessionUser, role: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  async function auditFor(recordId: string) {
    return db.select().from(auditEvent).where(eq(auditEvent.recordId, recordId))
  }

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(finance, 'finance_manager')
    const s = await asCm().seasons.create({
      name: `Test season ${tag}`,
      program: 'main_stage',
      startsOn: '2031-01-01',
      endsOn: '2031-12-31',
    })
    seasonId = s.id
    seasons.push(s.id)
    const p = await asCm().productions.create({
      seasonId,
      title: `Test production ${tag}`,
      rehearsalStart: '2031-02-01',
      techStart: '2031-02-20',
      opening: '2031-03-01',
      closing: '2031-03-20',
    })
    productionId = p.id
  })

  afterAll(async () => {
    const prods = db.select({ id: production.id }).from(production).where(inArray(production.seasonId, seasons))
    await db.delete(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(production).where(inArray(production.seasonId, seasons))
    await db.delete(season).where(inArray(season.id, seasons))
    const imported = db
      .select({ id: person.id })
      .from(person)
      .where(eq(person.email, email('juniper')))
    await db.delete(person).where(inArray(person.id, imported))
    if (people.length) await db.delete(person).where(inArray(person.id, people))
    if (agents.length) await db.delete(agent).where(inArray(agent.id, agents))
    await db.delete(agent).where(inArray(agent.name, [`Agent ${tag}`, `Rolled back ${tag}`, `Import agent ${tag}`]))
    await db.delete(user).where(inArray(user.id, [cm.id, finance.id]))
  })

  it('Finance can read the roster but not change it', async () => {
    await expect(
      asFinance().seasons.create({ name: 'Nope', program: 'main_stage', startsOn: '2031-01-01', endsOn: '2031-02-01' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const dash = await asFinance().seasons.dashboard({ id: seasonId })
    expect(dash.productions.map((p) => p.id)).toContain(productionId)
  })

  it('dates out of order are refused, including against dates already saved', async () => {
    await expect(
      asCm().productions.create({ seasonId, title: 'Backwards', opening: '2031-03-01', closing: '2031-02-01' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // Only the database knows the saved rehearsal date, so its check catches this one.
    await expect(asCm().productions.update({ id: productionId, opening: '2031-01-15' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('renaming a season leaves its program alone', async () => {
    const s = await asCm().seasons.create({
      name: `Kids ${tag}`,
      program: 'childrens_theatre',
      startsOn: '2031-06-01',
      endsOn: '2031-08-01',
    })
    seasons.push(s.id)
    await asCm().seasons.update({ id: s.id, name: `Kids renamed ${tag}` })
    const [row] = await db.select().from(season).where(eq(season.id, s.id))
    expect(row?.program).toBe('childrens_theatre')
  })

  let engagementId = ''
  let personId = ''

  it('the fast-entry form saves person, agent, deal and conflicts together, and logs each group without values', async () => {
    const r = await asCm().engagements.quickCreate({
      productionId,
      person: {
        kind: 'new',
        person: { legalName: `Fast Entry ${tag}`, email: email('fast'), homeAirport: 'BOS', dob: '1990-05-05' },
      },
      agent: { kind: 'new', agent: { name: `Agent ${tag}`, agency: 'Example Talent Group' } },
      terms: {
        role: 'Swing',
        contractType: 'equity_itc',
        weeklyPayCents: 115000,
        commissionPercent: 10,
        weeklyStipendCents: 25000,
        travelProvided: true,
        preferredArrival: '2031-01-31',
        preferredDeparture: '2031-03-21',
      },
      conflicts: [{ startsOn: '2031-02-10', endsOn: '2031-02-10', description: 'Callback in New York' }],
    })
    engagementId = r.id
    personId = r.personId
    people.push(personId)

    const detail = await asCm().engagements.get({ id: engagementId })
    expect(detail.engagement).toMatchObject({ role: 'Swing', weeklyPayCents: 115000, pipelineStatus: 'offer_accepted' })
    expect(detail.agent?.name).toBe(`Agent ${tag}`)
    expect(detail.conflicts).toHaveLength(1)
    if (detail.agent) agents.push(detail.agent.id)

    const events = await auditFor(engagementId)
    expect(events.every((e) => e.action === 'create')).toBe(true)
    expect(new Set(events.map((e) => e.fieldGroup))).toEqual(new Set(['general', 'contact', 'pay_terms']))
    expect(JSON.stringify(events.map((e) => e.detail))).not.toContain('115000')
    const personEvents = await auditFor(personId)
    expect(JSON.stringify(personEvents.map((e) => e.detail))).not.toContain('1990-05-05')
  })

  it('Finance sees the deal and the person, with the birth date masked', async () => {
    const detail = await asFinance().engagements.get({ id: engagementId })
    expect(detail.engagement.weeklyPayCents).toBe(115000)
    const p = await asFinance().people.get({ id: personId })
    expect(p.person.dob).toEqual({ masked: true, hasValue: true })
    expect(p.engagements).toHaveLength(1)
    expect(p.latestAgent?.name).toBe(`Agent ${tag}`)
  })

  it('a person can only be on a production once, and a failed save leaves nothing behind', async () => {
    await expect(
      asCm().engagements.quickCreate({
        productionId,
        person: { kind: 'existing', personId },
        agent: { kind: 'new', agent: { name: `Rolled back ${tag}` } },
        terms: { role: 'Ensemble', contractType: 'non_union' },
        conflicts: [],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'This person is already on that production.' })
    const leftovers = await db
      .select()
      .from(agent)
      .where(eq(agent.name, `Rolled back ${tag}`))
    expect(leftovers).toHaveLength(0)
  })

  it('editing one term leaves the status and the other terms as they were', async () => {
    await asCm().engagements.setStatus({ id: engagementId, status: 'contract_signed' })
    await asCm().engagements.update({ id: engagementId, role: 'Swing and dance captain' })
    const [row] = await db.select().from(engagement).where(eq(engagement.id, engagementId))
    expect(row).toMatchObject({
      role: 'Swing and dance captain',
      pipelineStatus: 'contract_signed',
      travelProvided: true,
      weeklyPayCents: 115000,
    })
  })

  it('status changes log where they came from and where they went', async () => {
    await asCm().engagements.setStatus({ id: engagementId, status: 'paperwork_complete' })
    const events = await auditFor(engagementId)
    const details = events.map((e) => e.detail as { from?: string; to?: string } | null)
    expect(details).toContainEqual(expect.objectContaining({ from: 'contract_signed', to: 'paperwork_complete' }))
    await expect(asFinance().engagements.setStatus({ id: engagementId, status: 'arrived' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('a masked field is write-only: saving it keeps it masked, and Reveal reads it back', async () => {
    await asCm().people.update({ id: personId, tsaKtn: 'TT1234567' })
    const p = await asCm().people.get({ id: personId })
    expect(p.person.tsaKtn).toEqual({ masked: true, hasValue: true })
    const shown = await asCm().people.reveal({ personId, field: 'tsaKtn' })
    expect(shown.value).toBe('TT1234567')
  })

  it('search finds people by name, and by email only for roles that can see email', async () => {
    const byName = await asFinance().people.search({ q: `Fast Entry ${tag}` })
    expect(byName.map((r) => r.id)).toEqual([personId])
    const byEmail = await asCm().people.search({ q: email('fast') })
    expect(byEmail.map((r) => r.id)).toEqual([personId])
    // Wildcards are taken literally.
    expect(await asCm().people.search({ q: '%%%' })).toEqual([])
  })

  it('the spreadsheet import previews without writing, refuses to commit with a problem row, then imports', async () => {
    const rows = [
      {
        legalName: `Juniper ${tag}`,
        email: email('juniper'),
        role: 'Swing',
        contractType: 'Equity ITC',
        weeklyPay: '$1,150',
        agentName: `Import agent ${tag}`,
        agency: 'Sample Artists Agency',
      },
      // Already on the production: skipped, not an error.
      { legalName: `Fast Entry ${tag}`, email: email('fast'), role: 'Swing', contractType: 'Equity ITC' },
      { legalName: '', role: 'Ensemble', contractType: 'Non-union' },
    ]
    const preview = await asCm().import.rows({ productionId, rows, dryRun: true })
    expect(preview.imported).toBe(false)
    expect(preview.counts).toEqual({ add: 1, skip: 1, error: 1 })
    expect(
      await db
        .select()
        .from(person)
        .where(eq(person.email, email('juniper'))),
    ).toHaveLength(0)

    const blocked = await asCm().import.rows({ productionId, rows, dryRun: false })
    expect(blocked.imported).toBe(false)
    expect(
      await db
        .select()
        .from(person)
        .where(eq(person.email, email('juniper'))),
    ).toHaveLength(0)

    const done = await asCm().import.rows({ productionId, rows: rows.slice(0, 2), dryRun: false })
    expect(done.imported).toBe(true)
    expect(done.results[0]).toMatchObject({ status: 'add', person: 'new', agent: 'new' })
    const [imported] = await db
      .select()
      .from(person)
      .where(eq(person.email, email('juniper')))
    expect(imported).toBeDefined()
    const deals = await db
      .select()
      .from(engagement)
      .where(and(eq(engagement.personId, imported!.id), eq(engagement.productionId, productionId)))
    expect(deals[0]?.weeklyPayCents).toBe(115000)
  })

  it('Finance cannot import', async () => {
    await expect(
      asFinance().import.rows({
        productionId,
        rows: [{ legalName: 'X', role: 'Y', contractType: 'SDC' }],
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('removing someone from a production deletes the deal and its conflicts, and keeps the person', async () => {
    await expect(asFinance().engagements.remove({ id: engagementId })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await asCm().engagements.remove({ id: engagementId })
    expect(await db.select().from(engagement).where(eq(engagement.id, engagementId))).toHaveLength(0)
    expect(await db.select().from(person).where(eq(person.id, personId))).toHaveLength(1)
    const events = await auditFor(engagementId)
    expect(events.some((e) => e.action === 'delete')).toBe(true)
  })

  it('the demo seed builds a full season of made-up people', async () => {
    const counts = await reseedDemo(db)
    expect(counts).toMatchObject({ seasons: 1, productions: 5, engagements: 25 })
    const again = await reseedDemo(db)
    expect(again).toEqual(counts)
    const demo = await db.select({ email: person.email }).from(person).where(eq(person.isDemo, true))
    expect(demo.every((p) => p.email?.endsWith('@example.com'))).toBe(true)
  })
})
