import { randomUUID } from 'node:crypto'
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectForm, fillForm, makeStandInForm, renderText } from '../server/contracts/pdf.js'
import { createDb, type Db } from '../server/db/client.js'
import {
  agent,
  auditEvent,
  contract,
  contractTemplate,
  engagement,
  person,
  production,
  season,
  user,
  userRole,
} from '../server/db/schema.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import type { Role } from '../shared/access.js'
import {
  blankFields,
  mergeBody,
  moneyInWords,
  overrideProblem,
  resolveContract,
  sdcRole,
  sdcTier,
  splitZip,
  unknownTokens,
  type ContractContext,
} from '../shared/contracts.js'

const createCaller = createCallerFactory(appRouter)

const CONTEXT: ContractContext = {
  today: '2031-01-05',
  employer: {
    name: 'Example Theatre',
    street: '1 Main St',
    cityStateZip: 'Raleigh, NC 27601',
    phone: null,
    email: null,
    signerName: 'Pat Example',
    ein: null,
    unemploymentNumber: 'NC 000',
    equityEmployerAgreement: 'ITC-1',
  },
  person: {
    legalName: 'Sam Sample',
    unionMemberId: 'M-1',
    email: 'sam@example.com',
    cell: null,
    homeStreet: null,
    homeCityStateZip: null,
  },
  engagement: { role: 'Director', weeklyPayCents: 105000, weeklyStipendCents: 25000, feeCents: 800000 },
  production: {
    title: 'A Play',
    rehearsalStart: '2031-02-01',
    opening: '2031-03-01',
    closing: '2031-03-20',
    venueName: 'Main Stage',
    venueCapacity: 280,
    topTicketCents: 6500,
    scheduledPerformances: 20,
    rehearsalLocation: 'Hall',
    rehearsalCallTime: '10:00 AM',
  },
  season: { name: '2031' },
}

describe('contract fill rules', () => {
  it('works out the SDC tier the way the form does', () => {
    // 280 seats is band 4, a $65 top ticket band 7, 20 performances band 2: average 4.33.
    expect(sdcTier(CONTEXT.production)).toEqual({
      capacity: 4,
      ticket: 7,
      performances: 2,
      tier: 4,
      healthCents: 1000_00,
    })
    expect(sdcTier({ ...CONTEXT.production, venueCapacity: null })).toBeNull()
  })

  it('writes pay in words and splits a ZIP off', () => {
    expect(moneyInWords(105000)).toBe('One thousand fifty dollars')
    expect(moneyInWords(123456)).toBe('One thousand two hundred thirty-four and 56/100 dollars')
    expect(splitZip('Raleigh, NC 27601')).toEqual({ rest: 'Raleigh, NC', zip: '27601' })
    expect(sdcRole('Director and choreographer')).toBe('Director/Choreographer')
    // Not one of the form's roles: left blank, so someone picks it before it goes out.
    expect(sdcRole('Associate Director')).toBe('')
  })

  it('a text template knows its tokens and leaves blanks visible', () => {
    expect(unknownTokens('Hi {{employee.name}} and {{nope}}')).toEqual(['nope'])
    expect(mergeBody('Pay: {{weekly_pay}}', { weekly_pay: '' })).toBe('Pay: ________')
  })

  it('a missing home address is a blank field, and Personal ID can’t be typed over', () => {
    const fields = resolveContract({ format: 'equity_itc_form', body: null }, CONTEXT, {})
    expect(blankFields(fields).map((f) => f.name)).toEqual(['EmployeeAddress', 'EmployeeCityStateZip'])
    expect(overrideProblem({ format: 'equity_itc_form', body: null }, 'EmployeeAddress', 'x')).toMatch(/profile/)
    expect(overrideProblem({ format: 'sdc_form', body: null }, 'Tier', '3')).toMatch(/venue numbers/)
    expect(overrideProblem({ format: 'equity_itc_form', body: null }, 'Duty', 'Chorus')).toBeNull()
  })

  it('fills a form and keeps it fillable', async () => {
    const blank = await makeStandInForm('sdc_form')
    expect((await inspectForm(blank)).format).toBe('sdc_form')
    const filled = await fillForm(blank, resolveContract({ format: 'sdc_form', body: null }, CONTEXT, {}))
    const form = (await PDFDocument.load(filled)).getForm()
    expect(form.getTextField('Artist').getText()).toBe('Sam Sample')
    expect(form.getTextField('production').getText()).toBe('A Play')
  })

  it('refuses a PDF that isn’t one of the union forms', async () => {
    await expect(inspectForm(await renderText('Rider', 'Just text'))).rejects.toThrow()
  })
})

const url = process.env.DATABASE_URL
describe.skipIf(!url)('contracts against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const tag = randomUUID().slice(0, 8)
  const cm: SessionUser = {
    id: `test-${randomUUID()}`,
    email: `cm-${tag}@example.com`,
    name: 'CM',
    twoFactorEnabled: true,
  }
  const finance: SessionUser = {
    id: `test-${randomUUID()}`,
    email: `fin-${tag}@example.com`,
    name: 'Finance',
    twoFactorEnabled: true,
  }
  const asCm = () => createCaller({ db, user: cm })
  const asFinance = () => createCaller({ db, user: finance })
  const templateIds: string[] = []
  const people: string[] = []
  let seasonId = ''
  let productionId = ''
  let actorId = ''
  let directorId = ''

  async function addUser(u: SessionUser, role: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  /** This test's contracts on an engagement, leaving out any made from other tests' or demo templates. */
  async function contractsOf(engagementId: string) {
    return db
      .select()
      .from(contract)
      .where(and(eq(contract.engagementId, engagementId), inArray(contract.templateId, templateIds)))
  }

  /** Prepares a deal's contracts and voids any from templates this test didn't make (the demo's, say). */
  async function prepare(engagementId: string) {
    await asCm().contracts.prepare({ engagementId })
    const others = await db
      .select({ id: contract.id })
      .from(contract)
      .where(and(eq(contract.engagementId, engagementId), notInArray(contract.templateId, templateIds)))
    for (const o of others) await asCm().contracts.void({ id: o.id })
  }

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(finance, 'finance_manager')
    const s = await asCm().seasons.create({
      name: `Contracts ${tag}`,
      program: 'main_stage',
      startsOn: '2031-01-01',
      endsOn: '2031-12-31',
    })
    seasonId = s.id
    const p = await asCm().productions.create({
      seasonId,
      title: `Contract play ${tag}`,
      rehearsalStart: '2031-02-01',
      opening: '2031-03-01',
      closing: '2031-03-20',
      venueName: 'Main Stage',
      venueCapacity: 280,
      topTicketCents: 6500,
      scheduledPerformances: 20,
      rehearsalLocation: 'Rehearsal Hall',
      rehearsalCallTime: '10:00 AM',
    })
    productionId = p.id
    const actor = await asCm().engagements.quickCreate({
      productionId,
      person: {
        kind: 'new',
        person: { legalName: `Actor ${tag}`, email: `actor-${tag}@example.com`, unionMemberId: 'E-1' },
      },
      agent: { kind: 'none' },
      terms: { role: 'Lead', contractType: 'equity_itc', weeklyPayCents: 105000 },
      conflicts: [],
    })
    actorId = actor.id
    people.push(actor.personId)
    const director = await asCm().engagements.quickCreate({
      productionId,
      person: {
        kind: 'new',
        person: {
          legalName: `Director ${tag}`,
          email: `director-${tag}@example.com`,
          unionMemberId: 'S-1',
          homeStreet: '5 Example Ave',
          homeCityStateZip: 'Boston, MA 02118',
        },
      },
      agent: { kind: 'none' },
      terms: { role: 'Director', contractType: 'sdc', weeklyPayCents: null, feeCents: 800000 },
      conflicts: [],
    })
    directorId = director.id
    people.push(director.personId)
  })

  afterAll(async () => {
    const prods = db.select({ id: production.id }).from(production).where(eq(production.seasonId, seasonId))
    await db.delete(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(production).where(eq(production.seasonId, seasonId))
    await db.delete(season).where(eq(season.id, seasonId))
    if (templateIds.length) await db.delete(contractTemplate).where(inArray(contractTemplate.id, templateIds))
    if (people.length) await db.delete(person).where(inArray(person.id, people))
    await db.delete(agent).where(eq(agent.name, `none-${tag}`))
    await db.delete(user).where(inArray(user.id, [cm.id, finance.id]))
  })

  it('Finance can read contract settings but not change them', async () => {
    await expect(asFinance().contracts.organization.save({ name: 'Nope' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await asCm().contracts.organization.save({
      name: 'Example Theatre',
      street: '1 Main St',
      cityStateZip: 'Raleigh, NC 27601',
      email: 'company@example.com',
      signerName: 'Pat Example',
      ein: '00-0000000',
      unemploymentNumber: 'NC 000',
      equityEmployerAgreement: 'ITC-1',
    })
    expect((await asFinance().contracts.organization.get()).name).toBe('Example Theatre')
  })

  it('takes the blank union forms and a rider, and refuses anything else', async () => {
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
    for (const format of ['equity_itc_form', 'sdc_form'] as const) {
      const t = await asCm().contracts.templates.uploadForm({
        name: `${format} ${tag}`,
        fileName: `${format}.pdf`,
        pdfBase64: b64(await makeStandInForm(format)),
      })
      templateIds.push(t.id)
    }
    await expect(
      asCm().contracts.templates.uploadForm({
        name: 'Plain',
        fileName: 'plain.pdf',
        pdfBase64: b64(await renderText('Plain', 'No fields')),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      asCm().contracts.templates.saveText({ name: 'Bad', contractType: 'equity_itc', body: 'Hi {{nobody}}' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const rider = await asCm().contracts.templates.saveText({
      name: `Rider ${tag}`,
      contractType: 'equity_itc',
      body: '# Rider\n{{employee.name}} plays {{role}} for {{weekly_pay}} a week.',
    })
    templateIds.push(rider.id)
  })

  it('prepares each deal’s contracts once, and won’t send one with a blank field', async () => {
    await prepare(actorId)
    await prepare(actorId)
    const mine = await contractsOf(actorId)
    expect(mine).toHaveLength(2)
    const form = mine.find((c) => c.templateId === templateIds[0])!
    const detail = await asCm().contracts.get({ id: form.id })
    expect(detail.blanks).toEqual(['Employee home address', 'Employee city, state, ZIP'])
    // Personal ID stays on the server: the app only learns whether it's filled.
    expect(detail.fields.find((f) => f.name === 'EmployeeAddress')).toMatchObject({ value: null, filled: false })
    await expect(
      asCm().contracts.setOverrides({ id: form.id, overrides: { EmployeeAddress: '1 Fake St' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      asCm().contracts.markSent({ id: form.id, sentOn: '2031-01-05', sentTo: 'them' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/home address/) })
  })

  it('sends, downloads, signs and moves the deal along the pipeline', async () => {
    const actorPerson = people[0]!
    await asCm().people.update({ id: actorPerson, homeStreet: '9 Sample Rd', homeCityStateZip: 'New York, NY 10025' })
    const [form, rider] = (await contractsOf(actorId)).sort((a) => (a.templateId === templateIds[0] ? -1 : 1)) as [
      typeof contract.$inferSelect,
      typeof contract.$inferSelect,
    ]
    await asCm().contracts.setOverrides({ id: form.id, overrides: { Duty: 'Principal' } })
    await asCm().contracts.markSent({ id: form.id, sentOn: '2031-01-05', sentTo: 'them and their agent' })
    expect((await asCm().engagements.get({ id: actorId })).engagement.pipelineStatus).toBe('contract_sent')

    const file = await asFinance().contracts.download({ id: form.id })
    const pdf = (await PDFDocument.load(Buffer.from(file.base64, 'base64'))).getForm()
    expect(pdf.getTextField('Employee').getText()).toBe(`Actor ${tag}`)
    expect(pdf.getTextField('EmployeeAddress').getText()).toBe('9 Sample Rd')
    expect(pdf.getTextField('CompensationShort').getText()).toBe('1,050.00')
    const logged = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.recordId, form.id), eq(auditEvent.action, 'download')))
    expect(logged.length).toBeGreaterThan(0)

    // A sent contract keeps what went out, even if the deal changes later.
    await asCm().engagements.update({ id: actorId, weeklyPayCents: 120000 })
    expect(
      (await asCm().contracts.get({ id: form.id })).fields.find((f) => f.name === 'CompensationShort')?.value,
    ).toBe('1,050.00')

    await expect(asCm().contracts.markSigned({ id: form.id, signedOn: '2031-01-01' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await asCm().contracts.markSigned({ id: form.id, signedOn: '2031-01-09' })
    // The rider is still a draft, so the deal isn't signed yet.
    expect((await asCm().engagements.get({ id: actorId })).engagement.pipelineStatus).toBe('contract_sent')
    await asCm().contracts.markSent({ id: rider.id, sentOn: '2031-01-05', sentTo: 'them' })
    await asCm().contracts.markSigned({ id: rider.id, signedOn: '2031-01-10' })
    expect((await asCm().engagements.get({ id: actorId })).engagement.pipelineStatus).toBe('contract_signed')
  })

  it('works out the SDC tier on the director’s agreement, and a voided contract can be prepared again', async () => {
    await prepare(directorId)
    const [sdc] = await contractsOf(directorId)
    const detail = await asCm().contracts.get({ id: sdc!.id })
    expect(detail.blanks).toEqual([])
    expect(detail.fields.find((f) => f.name === 'Tier')?.value).toBe('4')
    await asCm().contracts.void({ id: sdc!.id })
    await prepare(directorId)
    const after = await contractsOf(directorId)
    expect(after.map((c) => c.status).sort()).toEqual(['draft', 'void'])
    const status = await asFinance().contracts.byProduction({ productionId })
    expect(status.engagements.find((e) => e.id === directorId)?.contracts).toHaveLength(1)
  })
})
