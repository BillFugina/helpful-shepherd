import { randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderText } from '../server/contracts/pdf.js'
import { encryptField, fieldKey } from '../server/crypto/fields.js'
import { createDb, type Db } from '../server/db/client.js'
import {
  auditEvent,
  document,
  documentFile,
  engagement,
  person,
  production,
  season,
  user,
  userRole,
} from '../server/db/schema.js'
import { encryptFile, FILE_NAME_AAD } from '../server/documents/service.js'
import { csvCell, toCsv } from '../server/export/csv.js'
import { buildExport, EXPORT_FIELDS, exportColumns, slug } from '../server/export/build.js'
import { prepareEntry, writeZip } from '../server/export/zip.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants } from '../server/seed.js'
import { createCallerFactory, type SessionUser } from '../server/trpc.js'
import { DEFAULT_GRANTS, GUEST_EMAIL, GUEST_GRANTS, GUEST_USER_ID, type Role } from '../shared/access.js'

const createCaller = createCallerFactory(appRouter)
const url = process.env.DATABASE_URL
const noDb = new Proxy({} as Db, {
  get() {
    throw new Error('this test should not touch the database')
  },
})

/** Reads a ZIP back: name to bytes. Enough of the format to check what writeZip makes. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end).toBeGreaterThan(-1)
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50)
    const method = zip.readUInt16LE(at + 10)
    const compressed = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const offset = zip.readUInt32LE(at + 42)
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    const localName = zip.readUInt16LE(offset + 26)
    const localExtra = zip.readUInt16LE(offset + 28)
    const body = zip.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + compressed)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    expect(data.length).toBe(size)
    out.set(name, data)
    at += 46 + nameLength
  }
  return out
}

function parseCsv(text: string): Record<string, string>[] {
  // Enough for the rows these tests write: no line breaks inside values.
  const [head, ...lines] = text
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n')
  const split = (line: string) => {
    const cells: string[] = []
    let cur = ''
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"'
          i++
        } else if (ch === '"') quoted = false
        else cur += ch
      } else if (ch === '"') quoted = true
      else if (ch === ',') {
        cells.push(cur)
        cur = ''
      } else cur += ch
    }
    cells.push(cur)
    return cells
  }
  const columns = split(head!)
  return lines.map((l) => Object.fromEntries(split(l).map((v, i) => [columns[i]!, v])))
}

describe('export building blocks, without a database', () => {
  it('writes a ZIP that reads back byte for byte', () => {
    const big = Buffer.from('row,'.repeat(5000))
    const random = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919) % 256))
    const zip = writeZip([
      prepareEntry({ name: 'README.txt', data: Buffer.from('héllo') }),
      prepareEntry({ name: 'csv/big.csv', data: big }),
      prepareEntry({ name: 'files/r.bin', data: random }),
    ])
    const files = readZip(zip)
    expect([...files.keys()]).toEqual(['README.txt', 'csv/big.csv', 'files/r.bin'])
    expect(files.get('README.txt')!.toString('utf8')).toBe('héllo')
    expect(files.get('csv/big.csv')!.equals(big)).toBe(true)
    expect(files.get('files/r.bin')!.equals(random)).toBe(true)
    // Deflate actually ran on the repetitive file.
    expect(zip.length).toBeLessThan(big.length)
  })

  it('refuses entry names that climb out of the archive', () => {
    expect(() => prepareEntry({ name: '../x', data: Buffer.alloc(1) })).toThrow()
    expect(() => prepareEntry({ name: '/etc/x', data: Buffer.alloc(1) })).toThrow()
  })

  it('quotes CSV cells and keeps formulas from running', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a, b')).toBe('"a, b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(125000)).toBe('125000')
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(true)).toBe('true')
    expect(csvCell(new Date('2027-01-10T14:15:00Z'))).toBe('2027-01-10T14:15:00.000Z')
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('-12.50')).toBe('-12.50')
    expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell('+1 (919) 555-0100')).toBe('+1 (919) 555-0100')
    expect(toCsv(['a', 'b'], [{ a: 1, b: 'x' }, { a: null }])).toBe('a,b\r\n1,x\r\n,\r\n')
  })

  it('makes safe file names', () => {
    expect(slug('Zoë O’Brien / Lead')).toBe('Zoe-O-Brien-Lead')
    expect(slug('../../etc')).toBe('etc')
    expect(slug('!!!')).toBe('file')
  })

  it('leaves out masked groups unless asked, and admin tables unless admin', () => {
    const cm = { grants: DEFAULT_GRANTS.company_manager, isAdmin: true }
    const people = EXPORT_FIELDS.people
    expect(exportColumns(people, { ...cm, includeSensitive: false })).not.toContain('dob')
    expect(exportColumns(people, { ...cm, includeSensitive: false })).not.toContain('tsaKtn')
    expect(exportColumns(people, { ...cm, includeSensitive: true })).toEqual(expect.arrayContaining(['dob', 'tsaKtn']))
    expect(exportColumns(EXPORT_FIELDS.documents, { ...cm, includeSensitive: false })).not.toContain('fileName')
    expect(exportColumns(EXPORT_FIELDS.audit_log, { ...cm, includeSensitive: false })).toContain('action')

    // Finance's grants, if it were ever allowed to export: no travel, no housing, no admin tables.
    const fin = { grants: DEFAULT_GRANTS.finance_manager, isAdmin: false, includeSensitive: true }
    expect(exportColumns(EXPORT_FIELDS.people, fin)).not.toContain('tsaKtn')
    expect(exportColumns(EXPORT_FIELDS.flights, fin)).toEqual(['id', 'engagementId'])
    expect(exportColumns(EXPORT_FIELDS.housing_places, fin)).toEqual(['id'])
    expect(exportColumns(EXPORT_FIELDS.audit_log, fin)).toEqual(['id'])

    // The guest's grants never reach a masked group, even with includeSensitive.
    const g = { grants: GUEST_GRANTS, isAdmin: false, includeSensitive: true }
    expect(exportColumns(EXPORT_FIELDS.people, g)).not.toEqual(expect.arrayContaining(['dob']))
    expect(exportColumns(EXPORT_FIELDS.documents, g)).not.toContain('fileName')
  })

  it('every exported column is one the app registers', () => {
    for (const [table, fields] of Object.entries(EXPORT_FIELDS)) {
      for (const [column, group] of Object.entries(fields)) {
        expect(typeof group, `${table}.${column}`).toBe('string')
      }
    }
  })

  it('the guest, the connector and a login without two-factor can’t export', async () => {
    const guest: SessionUser = { id: GUEST_USER_ID, email: GUEST_EMAIL, name: 'Demo guest', twoFactorEnabled: false }
    await expect(createCaller({ db: noDb, user: guest }).export.download({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'DEMO_READ_ONLY',
    })
    const staff: SessionUser = { id: `test-${randomUUID()}`, email: 'x@example.com', name: 'X', twoFactorEnabled: true }
    await expect(createCaller({ db: noDb, user: staff, via: 'connector' }).export.download({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'CONNECTOR_READ_ONLY',
    })
    await expect(
      createCaller({ db: noDb, user: { ...staff, twoFactorEnabled: false } }).export.download({}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'TWO_FACTOR_REQUIRED' })
    await expect(createCaller({ db: noDb, user: null }).export.download({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })
})

describe.skipIf(!url)('export against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const tag = randomUUID().slice(0, 8)
  const mk = (role: string): SessionUser => ({
    id: `test-${randomUUID()}`,
    email: `${role}-${tag}@example.com`,
    name: role,
    twoFactorEnabled: true,
  })
  const cm = mk('cm')
  const finance = mk('fin')
  const asCm = () => createCaller({ db, user: cm })
  let seasonId = ''
  let personId = ''
  let engagementId = ''
  let documentId = ''
  const formBytes = Buffer.from('%PDF-1.7 a W-4 with an SSN 123-45-6789')

  async function addUser(u: SessionUser, role: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  async function download(includeSensitive: boolean) {
    const res = await asCm().export.download({ includeSensitive })
    const files = readZip(Buffer.from(res.base64, 'base64'))
    return { res, files }
  }

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(finance, 'finance_manager')
    const s = await asCm().seasons.create({
      name: `Export ${tag}`,
      program: 'main_stage',
      startsOn: '2032-01-01',
      endsOn: '2032-12-31',
    })
    seasonId = s.id
    const p = await asCm().productions.create({ seasonId, title: `Export play ${tag}`, rehearsalStart: '2032-02-01' })
    const e = await asCm().engagements.quickCreate({
      productionId: p.id,
      person: {
        kind: 'new',
        person: {
          legalName: `Exie Export ${tag}`,
          email: `exie-${tag}@example.com`,
          cell: '=1+1',
          dob: '1991-04-05',
          tsaKtn: 'KTN-EXPORT-1',
        },
      },
      agent: { kind: 'none' },
      terms: { role: 'Lead', contractType: 'equity_itc', weeklyPayCents: 125000 },
      conflicts: [],
    })
    engagementId = e.id
    personId = e.personId
    const [d] = await db
      .insert(document)
      .values({ engagementId, documentType: 'w4', status: 'received', receivedOn: '2032-01-10' })
      .returning({ id: document.id })
    documentId = d!.id
    await db.insert(documentFile).values({
      documentId,
      data: encryptFile(formBytes, documentId),
      fileNameEnc: encryptField('my w4.pdf', FILE_NAME_AAD, fieldKey()),
      mime: 'application/pdf',
      bytes: formBytes.length,
    })
  })

  afterAll(async () => {
    const prods = db.select({ id: production.id }).from(production).where(eq(production.seasonId, seasonId))
    await db.delete(engagement).where(inArray(engagement.productionId, prods))
    await db.delete(production).where(eq(production.seasonId, seasonId))
    await db.delete(season).where(eq(season.id, seasonId))
    if (personId) await db.delete(person).where(eq(person.id, personId))
    await db.delete(user).where(inArray(user.id, [cm.id, finance.id]))
  })

  it('Finance can’t export', async () => {
    await expect(createCaller({ db, user: finance }).export.download({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'ADMIN_ONLY',
    })
  })

  it('exports every table as CSV and JSON, without sensitive details by default', async () => {
    const { res, files } = await download(false)
    expect(res.fileName).toMatch(/^theatre-raleigh-export-\d{4}-\d{2}-\d{2}\.zip$/)
    expect(res.includesSensitive).toBe(false)
    expect(files.has('README.txt')).toBe(true)
    expect(files.has('data.json')).toBe(true)
    for (const t of ['people', 'engagements', 'productions', 'documents', 'audit_log', 'staff', 'role_access']) {
      expect(files.has(`csv/${t}.csv`), t).toBe(true)
    }
    const all = [...files.values()].map((b) => b.toString('latin1')).join('\n')
    expect(all).not.toContain('1991-04-05')
    expect(all).not.toContain('KTN-EXPORT-1')
    expect(all).not.toContain('123-45-6789')
    expect([...files.keys()].some((k) => k.startsWith('forms/'))).toBe(false)

    const people = parseCsv(files.get('csv/people.csv')!.toString('utf8'))
    const me = people.find((p) => p.id === personId)!
    expect(me.legalName).toBe(`Exie Export ${tag}`)
    expect(me.cell).toBe("'=1+1")
    expect('dob' in me).toBe(false)
    const eng = parseCsv(files.get('csv/engagements.csv')!.toString('utf8')).find((r) => r.id === engagementId)!
    expect(eng.weeklyPayCents).toBe('125000')
    expect(eng.personId).toBe(personId)
    const doc = parseCsv(files.get('csv/documents.csv')!.toString('utf8')).find((r) => r.id === documentId)!
    expect(doc.fileHeld).toBe('true')
    expect('fileName' in doc).toBe(false)

    const data = JSON.parse(files.get('data.json')!.toString('utf8'))
    expect(data.includesSensitive).toBe(false)
    expect(data.tables.people.find((p: { id: string }) => p.id === personId).cell).toBe('=1+1')
    // The staff list never carries a password or a guest.
    const staff = files.get('csv/staff.csv')!.toString('utf8')
    expect(staff).toContain(cm.email)
    expect(staff).not.toContain(GUEST_USER_ID)
    expect(staff.split('\r\n')[0]).toBe('\uFEFFid,name,email,role,twoFactorEnabled,createdAt,updatedAt')

    const [logged] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.actorId, cm.id), eq(auditEvent.action, 'export')))
    expect(logged).toMatchObject({ recordType: 'export', personId: null })
    expect(logged!.detail).toMatchObject({ includesSensitive: false })
    expect(JSON.stringify(logged!.detail)).not.toContain('Exie')
  })

  it('with sensitive details: decrypted fields and held forms, each logged against the person', async () => {
    const { res, files } = await download(true)
    expect(res.fileName).toMatch(/-sensitive\.zip$/)
    expect(res.includesSensitive).toBe(true)
    const me = parseCsv(files.get('csv/people.csv')!.toString('utf8')).find((p) => p.id === personId)!
    expect(me.dob).toBe('1991-04-05')
    expect(me.tsaKtn).toBe('KTN-EXPORT-1')

    const doc = parseCsv(files.get('csv/documents.csv')!.toString('utf8')).find((r) => r.id === documentId)!
    expect(doc.fileName).toBe('my w4.pdf')
    expect(doc.fileInExport).toMatch(new RegExp(`^forms/Exie-Export-${tag}-Export-play-${tag}-[0-9a-f]{8}/W-4\\.pdf$`))
    expect(files.get(doc.fileInExport!)!.equals(formBytes)).toBe(true)
    expect(files.get('README.txt')!.toString('utf8')).toContain('INCLUDES sensitive details')

    const events = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.actorId, cm.id), eq(auditEvent.action, 'export'), eq(auditEvent.personId, personId)))
    expect(events.map((e) => [e.fieldGroup, e.recordType]).sort()).toEqual([
      ['personal_id', 'person'],
      ['tax_bank', 'document_file'],
      ['travel_id', 'person'],
    ])
    expect(JSON.stringify(events)).not.toContain('1991-04-05')
  })

  const cmOpts = (includeSensitive: boolean, maxBytes?: number) => ({
    grants: DEFAULT_GRANTS.company_manager,
    isAdmin: true,
    includeSensitive,
    exportedBy: cm.email,
    maxBytes,
  })

  it('a form too large to include leaves out its file name and isn’t logged as read', async () => {
    // Random bytes don't compress, so this form can't fit a 200 KB export.
    const big = Buffer.from(Array.from({ length: 260_000 }, () => Math.floor(Math.random() * 256)))
    const [d] = await db
      .insert(document)
      .values({ engagementId, documentType: 'i9', status: 'received', receivedOn: '2032-01-11' })
      .returning({ id: document.id })
    await db.insert(documentFile).values({
      documentId: d!.id,
      data: encryptFile(big, d!.id),
      fileNameEnc: encryptField('passport scan.pdf', FILE_NAME_AAD, fieldKey()),
      mime: 'application/pdf',
      bytes: big.length,
    })
    try {
      const { zip, summary, sensitiveReads } = await buildExport(db, cmOpts(true, 200_000))
      const files = readZip(zip)
      const row = parseCsv(files.get('csv/documents.csv')!.toString('utf8')).find((r) => r.id === d!.id)!
      expect(row.fileHeld).toBe('true')
      expect(row.fileName).toBe('')
      expect(row.fileInExport).toBe('')
      expect(summary.skippedFiles.map((f) => f.path)).toContainEqual(expect.stringContaining('/I-9.'))
      expect(sensitiveReads.some((r) => r.recordId === d!.id)).toBe(false)
      expect([...files.values()].some((b) => b.toString('latin1').includes('passport scan'))).toBe(false)
      expect(files.get('README.txt')!.toString('utf8')).toContain('Files too large for one download')
    } finally {
      await db.delete(document).where(eq(document.id, d!.id))
    }
  })

  it('when the records outgrow one download, drops data.json and then the oldest audit entries', async () => {
    const marker = `export-size-${tag}`
    await db.insert(auditEvent).values(
      Array.from({ length: 3000 }, (_, i) => ({
        actorId: cm.id,
        action: 'read' as const,
        recordType: 'test',
        recordId: `${marker}-${i}-${randomUUID()}`,
      })),
    )
    const { zip, summary } = await buildExport(db, cmOpts(false, 200_000))
    expect(zip.length).toBeLessThanOrEqual(200_000)
    expect(summary.dataJson).toBe(false)
    expect(summary.auditRowsLeftOut).toBeGreaterThan(0)
    const files = readZip(zip)
    expect(files.has('data.json')).toBe(false)
    const audit = parseCsv(files.get('csv/audit_log.csv')!.toString('utf8'))
    // The newest entry is kept; the oldest ones go.
    // (Other test files may add entries meanwhile, so look for ours by marker.)
    expect(audit.some((r) => r.recordId?.startsWith(`${marker}-2999-`))).toBe(true)
    expect(audit.some((r) => r.recordId?.startsWith(`${marker}-0-`))).toBe(false)
    const readmeText = files.get('README.txt')!.toString('utf8')
    expect(readmeText).toContain(`The ${summary.auditRowsLeftOut} oldest audit log entries were left out`)
    expect(readmeText).toContain('data.json was left out')
    // Every other table is whole.
    expect(files.has('csv/people.csv')).toBe(true)
  })

  it('includes blank contract templates as PDFs', async () => {
    const pdf = Buffer.from(await renderText('Form', 'A blank form'))
    expect(pdf.length).toBeGreaterThan(0)
    const { files } = await download(false)
    const templates = parseCsv(files.get('csv/contract_templates.csv')!.toString('utf8'))
    for (const t of templates.filter((r) => r.pdfInExport)) {
      expect(files.get(t.pdfInExport!)!.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    }
  })
})
