import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { contractEmail, contractEmailKey, sentToWords } from '../server/contracts/email.js'
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
import { sendEmail } from '../server/email/send.js'
import { resetEnvForTests, type Env } from '../server/env.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import type { Role } from '../shared/access.js'

const createCaller = createCallerFactory(appRouter)

describe('contract email', () => {
  it('names the contract, the production and a copied agent, and asks for the signed copy by reply', () => {
    const m = contractEmail({
      firstName: 'Riley',
      theatre: 'Example Theatre',
      productionTitle: 'A Play',
      templateName: 'Rider',
      agentName: 'Sam Agent',
      senderName: 'Pat CM',
    })
    expect(m.subject).toBe('Rider: A Play')
    expect(m.text).toContain('Hi Riley,')
    expect(m.text).toContain('Your Rider for A Play at Example Theatre is attached. I’ve copied Sam Agent.')
    expect(m.text).toContain('replying to this email')
    expect(m.text.trim().endsWith('Pat CM\nExample Theatre')).toBe(true)
    expect(
      contractEmail({ ...m, firstName: '', theatre: '', productionTitle: 'P', templateName: 'T', senderName: '' }).text,
    ).not.toContain('copied')
  })

  it('says who it went to in names only', () => {
    expect(sentToWords('Riley', null)).toBe('Riley by email')
    expect(sentToWords('Riley', { name: 'Sam', agency: 'Talent Co' })).toBe(
      'Riley and their agent Sam (Talent Co) by email',
    )
  })

  it('gives the same email the same key, and a changed one a new key', () => {
    const a = contractEmailKey('c1', ['a@x.org', new Uint8Array([1, 2])])
    expect(contractEmailKey('c1', ['a@x.org', new Uint8Array([1, 2])])).toBe(a)
    expect(contractEmailKey('c1', ['a@x.org', new Uint8Array([1, 3])])).not.toBe(a)
    expect(contractEmailKey('c2', ['a@x.org', new Uint8Array([1, 2])])).not.toBe(a)
  })

  it('sends copies only to allowed addresses, with the attachment and the key', async () => {
    const calls: { headers: Record<string, string>; body: Record<string, unknown> }[] = []
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const e = {
      RESEND_API_KEY: 're_test',
      EMAIL_FROM: 'T <r@t.org>',
      EMAIL_DELIVERY: 'allowlist',
      EMAIL_ALLOWLIST: 'a@real.org, b@real.org',
    } as Env
    const result = await sendEmail(
      {
        to: 'a@real.org',
        cc: ['B@real.org', 'nope@real.org', 'a@real.org', 'x@example.com'],
        subject: 'S',
        text: 'T',
        attachments: [{ filename: 'c\n.pdf', content: 'QUJD' }],
        idempotencyKey: 'k1',
      },
      { isDemo: false },
      { fetch: fakeFetch, env: e },
    )
    expect(result).toEqual({ delivery: 'sent' })
    expect(calls[0]!.body.cc).toEqual(['b@real.org'])
    expect(calls[0]!.body.attachments).toEqual([{ filename: 'c .pdf', content: 'QUJD' }])
    expect(calls[0]!.headers['Idempotency-Key']).toBe('k1')
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)('emailing a contract against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const tag = randomUUID().slice(0, 8)
  const domain = `shepherd-${tag}.org`
  const personEmail = `actor@${domain}`
  const agentEmail = `agent@${domain}`
  const cm: SessionUser = {
    id: `test-${randomUUID()}`,
    email: `cm@shepherd-${tag}.org`,
    name: 'Pat CM',
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
  let seasonId = ''
  let engagementId = ''
  let personId = ''
  let templateId = ''
  const saved = { ...process.env }

  async function addUser(u: SessionUser, role: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  /** A fresh draft of this test's template, voiding any made from other templates. */
  async function freshDraft(): Promise<string> {
    await asCm().contracts.prepare({ engagementId })
    const rows = await db
      .select({ id: contract.id, templateId: contract.templateId, status: contract.status })
      .from(contract)
      .where(eq(contract.engagementId, engagementId))
    for (const r of rows.filter((r) => r.templateId !== templateId && r.status !== 'void')) {
      await asCm().contracts.void({ id: r.id })
    }
    return rows.find((r) => r.templateId === templateId && r.status === 'draft')!.id
  }

  function emailOn(allow: string[]) {
    process.env.RESEND_API_KEY = 're_test'
    process.env.EMAIL_FROM = 'Theatre <r@t.org>'
    process.env.EMAIL_DELIVERY = 'allowlist'
    process.env.EMAIL_ALLOWLIST = allow.join(',')
    resetEnvForTests()
  }

  function fakeResend(status = 200) {
    const calls: { headers: Record<string, string>; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
      return new Response('{}', { status })
    })
    return calls
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const k of ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_DELIVERY', 'EMAIL_ALLOWLIST'] as const) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    resetEnvForTests()
  })

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(finance, 'finance_manager')
    const s = await asCm().seasons.create({
      name: `Email ${tag}`,
      program: 'main_stage',
      startsOn: '2031-01-01',
      endsOn: '2031-12-31',
    })
    seasonId = s.id
    const p = await asCm().productions.create({ seasonId, title: `Email play ${tag}`, rehearsalStart: '2031-02-01' })
    const t = await asCm().contracts.templates.saveText({
      name: `Letter ${tag}`,
      contractType: 'non_union',
      body: 'Dear {{employee.name}}, you are our {{role}}.',
    })
    templateId = t.id
    const eng = await asCm().engagements.quickCreate({
      productionId: p.id,
      person: { kind: 'new', person: { legalName: `Riley Actor ${tag}`, email: personEmail } },
      agent: { kind: 'new', agent: { name: `Sam Agent ${tag}`, agency: 'Talent Co', email: agentEmail } },
      terms: { role: 'Ensemble', contractType: 'non_union', weeklyPayCents: 50000 },
      conflicts: [],
    })
    engagementId = eng.id
    personId = eng.personId
  })

  afterAll(async () => {
    const prods = db.select({ id: production.id }).from(production).where(eq(production.seasonId, seasonId))
    const [eng] = await db
      .select({ agentId: engagement.agentId })
      .from(engagement)
      .where(eq(engagement.id, engagementId))
    await db.delete(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(production).where(eq(production.seasonId, seasonId))
    await db.delete(season).where(eq(season.id, seasonId))
    await db.delete(contractTemplate).where(eq(contractTemplate.id, templateId))
    await db.delete(person).where(eq(person.id, personId))
    if (eng?.agentId) await db.delete(agent).where(eq(agent.id, eng.agentId))
    await db.delete(user).where(inArray(user.id, [cm.id, finance.id]))
  })

  it('shows who it would go to, and Finance can’t send it', async () => {
    const id = await freshDraft()
    const detail = await asCm().contracts.get({ id })
    expect(detail.recipients).toEqual({
      person: { name: `Riley Actor ${tag}`, email: personEmail },
      agent: { name: `Sam Agent ${tag}`, agency: 'Talent Co', email: agentEmail },
    })
    expect(detail.emailMode).toBe('log')
    await expect(asFinance().contracts.email({ id, copyAgent: true })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('with email off, hands the email back and leaves the contract a draft', async () => {
    const id = await freshDraft()
    const calls = fakeResend()
    const r = await asCm().contracts.email({ id, copyAgent: true })
    expect(r).toMatchObject({ outcome: 'logged', movedTo: null })
    expect(r.email).toMatchObject({ to: personEmail, cc: [agentEmail], subject: `Letter ${tag}: Email play ${tag}` })
    expect(calls).toHaveLength(0)
    const [row] = await db.select().from(contract).where(eq(contract.id, id))
    expect(row!.status).toBe('draft')
  })

  it('leaves it a draft when the email service fails', async () => {
    const id = await freshDraft()
    emailOn([personEmail, agentEmail])
    fakeResend(500)
    await expect(asCm().contracts.email({ id, copyAgent: true })).rejects.toThrow(/didn’t take the email/)
    const [row] = await db.select().from(contract).where(eq(contract.id, id))
    expect(row).toMatchObject({ status: 'draft', sentOn: null })
    const sends = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.recordId, id), eq(auditEvent.action, 'send')))
    expect(sends).toHaveLength(0)
  })

  it('emails the PDF to the person, copies the agent, marks it sent and moves the deal along', async () => {
    const id = await freshDraft()
    emailOn([personEmail, agentEmail])
    const calls = fakeResend()
    const r = await asCm().contracts.email({ id, copyAgent: true })
    expect(r).toMatchObject({ outcome: 'sent', movedTo: 'contract_sent', agent: { outcome: 'sent' } })
    expect(calls).toHaveLength(1)
    const body = calls[0]!.body
    expect(body).toMatchObject({ to: [personEmail], cc: [agentEmail], reply_to: cm.email })
    const [file] = body.attachments as { filename: string; content: string }[]
    expect(file!.filename).toMatch(/\.pdf$/)
    expect(Buffer.from(file!.content, 'base64').subarray(0, 5).toString()).toBe('%PDF-')
    expect(calls[0]!.headers['Idempotency-Key']).toMatch(new RegExp(`^contract/${id}/`))

    const [row] = await db.select().from(contract).where(eq(contract.id, id))
    expect(row).toMatchObject({
      status: 'sent',
      sentTo: `Riley Actor ${tag} and their agent Sam Agent ${tag} (Talent Co) by email`,
    })
    expect((await asCm().engagements.get({ id: engagementId })).engagement.pipelineStatus).toBe('contract_sent')

    // The log says who by kind, never the address.
    const sends = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.recordId, id), eq(auditEvent.action, 'send')))
    expect(sends.length).toBeGreaterThan(0)
    expect(JSON.stringify(sends.map((s) => s.detail))).not.toContain(domain)
    expect(sends[0]!.detail).toMatchObject({ via: 'email', to: ['person', 'agent'] })

    // Once sent, it can't go again.
    await expect(asCm().contracts.email({ id, copyAgent: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await asCm().contracts.void({ id })
  })

  it('leaves the agent’s copy off when that address isn’t allowed, and can skip the agent', async () => {
    let id = await freshDraft()
    emailOn([personEmail])
    let calls = fakeResend()
    const r = await asCm().contracts.email({ id, copyAgent: true })
    expect(r).toMatchObject({ outcome: 'sent', agent: { outcome: 'left_off' } })
    expect(calls[0]!.body.cc).toBeUndefined()
    const [row] = await db.select().from(contract).where(eq(contract.id, id))
    expect(row!.sentTo).toBe(`Riley Actor ${tag} by email`)
    await asCm().contracts.void({ id })

    id = await freshDraft()
    calls = fakeResend()
    const skipped = await asCm().contracts.email({ id, copyAgent: false })
    expect(skipped.outcome).toBe('sent')
    expect(skipped.agent).toBeUndefined()
    expect(calls[0]!.body.cc).toBeUndefined()
    await asCm().contracts.void({ id })
  })

  it('won’t send without an address for the person', async () => {
    const id = await freshDraft()
    await asCm().people.update({ id: personId, email: null })
    emailOn([personEmail])
    fakeResend()
    await expect(asCm().contracts.email({ id, copyAgent: false })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/no email address/),
    })
    await asCm().people.update({ id: personId, email: personEmail })
    const [row] = await db.select().from(contract).where(eq(contract.id, id))
    expect(row!.status).toBe('draft')
  })
})
