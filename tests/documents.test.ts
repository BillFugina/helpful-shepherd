import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderText } from '../server/contracts/pdf.js'
import { CONNECTOR_TOOLS } from '../server/connector/tools.js'
import { createDb, type Db } from '../server/db/client.js'
import {
  auditEvent,
  document,
  documentFile,
  engagement,
  person,
  production,
  roleGrant,
  season,
  uploadLink,
  user,
  userRole,
} from '../server/db/schema.js'
import { decryptFile, encryptFile, hashLinkToken, newLinkToken, purgeExpired } from '../server/documents/service.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import { GUEST_EMAIL, GUEST_GRANTS, GUEST_USER_ID, NEVER_FOR_GUEST, NEVER_OVER_CONNECTOR } from '../shared/access.js'
import type { Role } from '../shared/access.js'
import { buildChecklist, linkToken, sniffMime, summarize, type DocumentRow } from '../shared/documents.js'

const createCaller = createCallerFactory(appRouter)
const url = process.env.DATABASE_URL
const guest: SessionUser = { id: GUEST_USER_ID, email: GUEST_EMAIL, name: 'Demo guest', twoFactorEnabled: false }

describe('document rules, without a database', () => {
  const row = (documentType: DocumentRow['documentType'], status: DocumentRow['status']): DocumentRow => ({
    id: randomUUID(),
    documentType,
    status,
    hasFile: false,
    receivedOn: null,
    receivedVia: null,
    sentToFinanceAt: null,
    acceptedAt: null,
    filePurgedAt: null,
    financeNote: null,
  })

  it('builds a checklist from the requirements, with Missing for forms not started', () => {
    const items = buildChecklist(['w9', 'direct_deposit'], [row('direct_deposit', 'accepted'), row('i9', 'received')])
    expect(items.map((i) => [i.documentType, i.status, i.required])).toEqual([
      ['i9', 'received', false],
      ['w9', 'missing', true],
      ['direct_deposit', 'accepted', true],
    ])
    const s = summarize(items)
    expect(s).toMatchObject({ total: 2, missing: 1, done: 1, complete: false })
    // A form off the list never holds anyone up.
    expect(summarize(buildChecklist(['w9'], [row('w9', 'not_needed'), row('i9', 'received')])).complete).toBe(true)
  })

  it('knows a file by its bytes, not its name', () => {
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf')
    expect(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffMime(new TextEncoder().encode('<html>'))).toBeNull()
  })

  it('encrypts files bound to their document', () => {
    const id = randomUUID()
    const plain = Buffer.from('%PDF-1.7 secret W-4')
    const stored = encryptFile(plain, id)
    expect(stored.includes(plain)).toBe(false)
    expect(decryptFile(stored, id).equals(plain)).toBe(true)
    expect(() => decryptFile(stored, randomUUID())).toThrow()
  })

  it('makes unguessable link tokens and keeps only a hash', () => {
    const token = newLinkToken()
    expect(linkToken.safeParse(token).success).toBe(true)
    expect(hashLinkToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashLinkToken(token)).not.toContain(token)
  })

  it('the guest sees statuses but never files, and files never go over the connector', () => {
    expect(GUEST_GRANTS.documents).toBe('view')
    expect(GUEST_GRANTS.tax_bank).toBeUndefined()
    expect(NEVER_FOR_GUEST.has('tax_bank')).toBe(true)
    expect(NEVER_OVER_CONNECTOR.has('tax_bank')).toBe(true)
    expect(NEVER_OVER_CONNECTOR.has('documents')).toBe(false)
  })

  it('the guest can’t download a form', async () => {
    const db = new Proxy({} as Db, {
      get() {
        throw new Error('this test should not touch the database')
      },
    })
    await expect(
      createCaller({ db, user: guest }).documents.download({ engagementId: randomUUID(), documentType: 'w4' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe.skipIf(!url)('documents against Postgres', () => {
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
  const asConnector = () => createCaller({ db, user: cm, via: 'connector' })
  const people: string[] = []
  let seasonId = ''
  let productionId = ''
  let actorId = ''
  let pdf: Buffer
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

  async function addUser(u: SessionUser, role: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  async function makeLink() {
    const { url: link } = await asCm().documents.links.create({
      engagementId: actorId,
      documentTypes: ['w4', 'nc4', 'i9', 'equity_deferral', 'direct_deposit', 'bank_verification'],
    })
    return link.split('/upload/')[1]!
  }

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(finance, 'finance_manager')
    pdf = Buffer.from(await renderText('W-4', 'A test form'))
    const s = await asCm().seasons.create({
      name: `Documents ${tag}`,
      program: 'main_stage',
      startsOn: '2031-01-01',
      endsOn: '2031-12-31',
    })
    seasonId = s.id
    const p = await asCm().productions.create({
      seasonId,
      title: `Document play ${tag}`,
      rehearsalStart: '2031-02-01',
      opening: '2031-03-01',
      closing: '2031-03-20',
    })
    productionId = p.id
    const actor = await asCm().engagements.quickCreate({
      productionId,
      person: { kind: 'new', person: { legalName: `Avery Actor ${tag}`, preferredName: 'Avery' } },
      agent: { kind: 'none' },
      terms: { role: 'Lead', contractType: 'equity_itc', weeklyPayCents: 105000 },
      conflicts: [],
    })
    actorId = actor.id
    people.push(actor.personId)
  })

  afterAll(async () => {
    const prods = db.select({ id: production.id }).from(production).where(eq(production.seasonId, seasonId))
    await db.delete(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(production).where(eq(production.seasonId, seasonId))
    await db.delete(season).where(eq(season.id, seasonId))
    if (people.length) await db.delete(person).where(inArray(person.id, people))
    await db.delete(user).where(inArray(user.id, [cm.id, finance.id]))
  })

  it('starts with every form for the contract type missing', async () => {
    const d = await asCm().documents.forEngagement({ engagementId: actorId })
    expect(d.checklist.map((i) => i.documentType)).toEqual([
      'w4',
      'nc4',
      'i9',
      'equity_deferral',
      'direct_deposit',
      'bank_verification',
    ])
    expect(d.checklist.every((i) => i.status === 'missing')).toBe(true)
    expect(d.summary).toMatchObject({ total: 6, missing: 6, complete: false })
  })

  it('Finance can’t upload, make links or change settings', async () => {
    const ref = { engagementId: actorId, documentType: 'w4' as const }
    await expect(asFinance().documents.upload({ ...ref, fileName: 'w4.pdf', base64: b64(pdf) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      asFinance().documents.links.create({ engagementId: actorId, documentTypes: ['w4'] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      asFinance().documents.settings.save({ linkDays: 7, retentionYears: 3, retentionConfirmed: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('an upload link keeps only a hash, and shows the person their first name and forms', async () => {
    const token = await makeLink()
    const stored = await db.select().from(uploadLink).where(eq(uploadLink.engagementId, actorId))
    expect(stored.some((l) => l.tokenHash === hashLinkToken(token))).toBe(true)
    expect(JSON.stringify(stored)).not.toContain(token)
    const page = await createCaller({ db, user: null }).uploadLink.get({ token })
    expect(page.firstName).toBe('Avery')
    expect(page.items).toHaveLength(6)
    await expect(createCaller({ db, user: null }).uploadLink.get({ token: newLinkToken() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('takes a PDF through the link, encrypted, and refuses anything else', async () => {
    const token = await makeLink()
    const anon = createCaller({ db, user: null })
    await expect(
      anon.uploadLink.send({
        token,
        documentType: 'w4',
        fileName: 'w4.html',
        base64: b64(Buffer.from('<html>hi</html>')),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await anon.uploadLink.send({ token, documentType: 'w4', fileName: 'my w4.pdf', base64: b64(pdf) })
    const [row] = await db
      .select({ document, file: documentFile })
      .from(document)
      .innerJoin(documentFile, eq(documentFile.documentId, document.id))
      .where(and(eq(document.engagementId, actorId), eq(document.documentType, 'w4')))
    expect(row!.document.status).toBe('received')
    expect(row!.document.receivedVia).toBe('upload_link')
    expect(row!.file.data.includes(pdf.subarray(0, 64))).toBe(false)
    expect(row!.file.fileNameEnc).not.toContain('my w4')
    const events = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.recordId, row!.document.id), eq(auditEvent.via, 'upload_link')))
    expect(events.length).toBeGreaterThan(0)
  })

  it('opens the file for the Company Manager, logged, and never over the connector', async () => {
    const ref = { engagementId: actorId, documentType: 'w4' as const }
    const f = await asCm().documents.download(ref)
    expect(f.fileName).toBe('my w4.pdf')
    expect(Buffer.from(f.base64, 'base64').equals(pdf)).toBe(true)
    await expect(asConnector().documents.download(ref)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const logged = await db
      .select()
      .from(auditEvent)
      .where(
        and(eq(auditEvent.actorId, cm.id), eq(auditEvent.action, 'download'), eq(auditEvent.fieldGroup, 'tax_bank')),
      )
    expect(logged.length).toBeGreaterThan(0)
  })

  it('Finance sends a form back with a note, and the person sees it on their link', async () => {
    const ref = { engagementId: actorId, documentType: 'w4' as const }
    await asCm().documents.sendToFinance(ref)
    const queue = await asFinance().documents.financeQueue()
    expect(queue.some((q) => q.engagementId === actorId && q.documentType === 'w4')).toBe(true)
    await asFinance().documents.flag({ ...ref, note: 'Wrong year' })
    const token = await makeLink()
    const page = await createCaller({ db, user: null }).uploadLink.get({ token })
    expect(page.items.find((i) => i.documentType === 'w4')).toMatchObject({ open: true, note: 'Wrong year' })
  })

  it('accepting deletes the app’s copy and keeps the status', async () => {
    const ref = { engagementId: actorId, documentType: 'w4' as const }
    await asCm().documents.upload({ ...ref, fileName: 'w4-2031.pdf', base64: b64(pdf) })
    await asCm().documents.sendToFinance(ref)
    await asFinance().documents.accept(ref)
    const [doc] = await db
      .select()
      .from(document)
      .where(and(eq(document.engagementId, actorId), eq(document.documentType, 'w4')))
    expect(doc).toMatchObject({ status: 'accepted', financeNote: null })
    expect(doc!.filePurgedAt).not.toBeNull()
    expect(await db.select().from(documentFile).where(eq(documentFile.documentId, doc!.id))).toHaveLength(0)
    await expect(asCm().documents.download(ref)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('marking a form Not needed deletes its file only for a role that can manage files', async () => {
    const ref = { engagementId: actorId, documentType: 'direct_deposit' as const }
    await asCm().documents.upload({ ...ref, fileName: 'deposit.pdf', base64: b64(pdf) })
    const where = and(eq(roleGrant.role, 'finance_manager'), eq(roleGrant.fieldGroup, 'documents'))
    const [before] = await db.select({ level: roleGrant.level }).from(roleGrant).where(where)
    await db.update(roleGrant).set({ level: 'edit' }).where(where)
    try {
      await expect(asFinance().documents.markNotNeeded(ref)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    } finally {
      await db.update(roleGrant).set({ level: before!.level }).where(where)
    }
    const [doc] = await db
      .select()
      .from(document)
      .where(and(eq(document.engagementId, actorId), eq(document.documentType, 'direct_deposit')))
    expect(doc!.status).toBe('received')
    expect(await db.select().from(documentFile).where(eq(documentFile.documentId, doc!.id))).toHaveLength(1)
    await asCm().documents.removeFile(ref)
  })

  it('a signed deal moves to Paperwork complete once every form is done', async () => {
    await db.update(engagement).set({ pipelineStatus: 'contract_signed' }).where(eq(engagement.id, actorId))
    for (const documentType of ['nc4', 'i9', 'equity_deferral', 'direct_deposit'] as const) {
      await asCm().documents.markNotNeeded({ engagementId: actorId, documentType })
    }
    const ref = { engagementId: actorId, documentType: 'bank_verification' as const }
    await asCm().documents.upload({ ...ref, fileName: 'check.pdf', base64: b64(pdf) })
    await asCm().documents.sendToFinance(ref)
    const result = await asFinance().documents.accept(ref)
    expect(result.paperworkComplete).toBe(true)
    const [eng] = await db.select().from(engagement).where(eq(engagement.id, actorId))
    expect(eng!.pipelineStatus).toBe('paperwork_complete')
  })

  it('a link with nothing left to collect, or turned off, stops working', async () => {
    const anon = createCaller({ db, user: null })
    await asCm().documents.reopen({ engagementId: actorId, documentType: 'nc4' })
    const fresh = await makeLink()
    expect((await anon.uploadLink.get({ token: fresh })).items.filter((i) => i.open)).toHaveLength(1)
    const [link] = await db
      .select()
      .from(uploadLink)
      .where(eq(uploadLink.tokenHash, hashLinkToken(fresh)))
    await asCm().documents.links.revoke({ id: link!.id })
    await expect(anon.uploadLink.get({ token: fresh })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('the backstop deletes any file still held past the retention period', async () => {
    const ref = { engagementId: actorId, documentType: 'nc4' as const }
    await asCm().documents.upload({ ...ref, fileName: 'nc4.pdf', base64: b64(pdf) })
    // The production closes in 2031, so a run "now" deletes nothing; one in 2040 does.
    expect(await purgeExpired(db, new Date(), true)).toBe(0)
    expect(await purgeExpired(db, new Date('2040-01-01T00:00:00Z'), true)).toBeGreaterThanOrEqual(1)
    const [doc] = await db
      .select()
      .from(document)
      .where(and(eq(document.engagementId, actorId), eq(document.documentType, 'nc4')))
    expect(await db.select().from(documentFile).where(eq(documentFile.documentId, doc!.id))).toHaveLength(0)
    expect(doc!.filePurgedAt).not.toBeNull()
  })

  it('the connector reads statuses only', async () => {
    const result = await CONNECTOR_TOOLS.missing_documents.run(
      { productionId },
      { db, user: cm, clientId: 'test-client' },
    )
    const text = JSON.stringify(result.data)
    expect(text).toContain('NC-4 withholding')
    expect(text).not.toContain('base64')
    expect(text).not.toContain('nc4.pdf')
  })
})
