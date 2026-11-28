import { asc, eq, ne } from 'drizzle-orm'
import {
  FIELD_GROUP_LABELS,
  GUEST_USER_ID,
  levelAtLeast,
  levelFor,
  MASKED_GROUPS,
  PERSON_FIELDS,
  ROLE_LABELS,
  type FieldGroup,
  type Grants,
} from '../../shared/access.js'
import { CONTRACT_FIELDS, ORGANIZATION_FIELDS, TEMPLATE_FIELDS } from '../../shared/contracts.js'
import { DOCUMENT_TYPE_LABELS, type FileMime } from '../../shared/documents.js'
import { EXPORT_TABLES, MAX_EXPORT_BYTES, type ExportSummary, type ExportTableName } from '../../shared/export.js'
import {
  AGENT_FIELDS,
  CONFLICT_FIELDS,
  ENGAGEMENT_FIELDS,
  PRODUCTION_FIELDS,
  SEASON_FIELDS,
} from '../../shared/roster.js'
import {
  FLIGHT_FIELDS,
  HOUSING_ASSIGNMENT_FIELDS,
  HOUSING_PREFERENCE_FIELDS,
  HOUSING_ROOM_FIELDS,
  HOUSING_UNIT_FIELDS,
  RENTAL_CAR_FIELDS,
} from '../../shared/travel.js'
import { theatreToday } from '../contracts/service.js'
import { decryptField, fieldKey } from '../crypto/fields.js'
import type { Db } from '../db/client.js'
import {
  agent,
  auditEvent,
  conflict,
  contract,
  contractTemplate,
  document,
  documentFile,
  documentRequirement,
  documentSettings,
  engagement,
  engagementDraft,
  flight,
  flightEvent,
  housingAssignment,
  housingPreference,
  housingRoom,
  housingUnit,
  organization,
  person,
  production,
  reminderSettings,
  rentalCar,
  roleGrant,
  season,
  user,
  userRole,
} from '../db/schema.js'
import { FILE_NAME_AAD, decryptFile } from '../documents/service.js'
import { PERSON_STORAGE, toPersonRecord } from '../registry/person.js'
import { toCsv } from './csv.js'
import { entrySize, prepareEntry, writeZip, ZIP_OVERHEAD } from './zip.js'

/**
 * Builds the full data export. Every table goes through the caller's field
 * group grants, the same registries the app's screens use: a column whose
 * group the role can't view is left out, and so is any column the registry
 * doesn't name, so a new column never leaks by being forgotten here. The
 * masked groups come out only when includeSensitive is set, decrypted.
 *
 * Staff logins, role access, drafts and the audit log are the Company
 * Manager's alone (isAdmin). Sign-in secrets, sessions, two-factor keys,
 * connector tokens, upload link tokens, phone alert device keys and the flight
 * feed's subscriptions are never exported: they're the app's plumbing, not
 * the theater's records, and some would let a holder in.
 */

/** 'admin' columns come out only for the Company Manager. */
type ExportGroup = FieldGroup | 'id' | 'admin'
type ExportFields = Readonly<Record<string, ExportGroup>>
type Row = Record<string, unknown>

export interface ExportOptions {
  grants: Grants
  isAdmin: boolean
  includeSensitive: boolean
  exportedBy: string
  now?: Date
  /** The largest ZIP to build. Defaults to what one Vercel response can carry; tests lower it. */
  maxBytes?: number
}

/** What the export put in the file that the audit log should hear about, per person. */
export interface SensitiveRead {
  personId: string
  fieldGroup: FieldGroup
  recordType: 'person' | 'document_file'
  recordId: string
  detail?: Record<string, unknown>
}

export interface ExportResult {
  zip: Buffer
  summary: ExportSummary
  sensitiveReads: SensitiveRead[]
}

/** The records alone are more than one download can carry. */
export class ExportTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`The export came to ${bytes} bytes, more than one download can carry.`)
  }
}

interface Table {
  name: ExportTableName
  fields: ExportFields
  rows: Row[]
}

const times = (group: ExportGroup) => ({ createdAt: group, updatedAt: group }) as const

/** The column sets this export writes, by table. Built from the app's own registries. */
export const EXPORT_FIELDS = {
  seasons: { ...SEASON_FIELDS, isDemo: 'general', ...times('general') },
  productions: { ...PRODUCTION_FIELDS, isDemo: 'general', ...times('general') },
  people: { ...PERSON_FIELDS, isDemo: 'general', ...times('general') },
  agents: { ...AGENT_FIELDS, isDemo: 'contact', ...times('contact') },
  engagements: { ...ENGAGEMENT_FIELDS, isDemo: 'general', ...times('general') },
  conflicts: { ...CONFLICT_FIELDS, ...times('general') },
  housing_needs: { ...HOUSING_PREFERENCE_FIELDS, ...times('general') },
  flights: { ...FLIGHT_FIELDS, ...times('travel_logistics') },
  flight_alerts: {
    id: 'id',
    flightId: 'id',
    at: 'travel_logistics',
    kind: 'travel_logistics',
    detail: 'travel_logistics',
    alertedAt: 'travel_logistics',
  },
  rental_cars: { ...RENTAL_CAR_FIELDS, ...times('travel_logistics') },
  housing_places: { ...HOUSING_UNIT_FIELDS, isDemo: 'housing', ...times('housing') },
  housing_rooms: { ...HOUSING_ROOM_FIELDS, ...times('housing') },
  housing_stays: { ...HOUSING_ASSIGNMENT_FIELDS, ...times('housing') },
  organization: { ...ORGANIZATION_FIELDS, updatedAt: 'contracts' },
  contract_templates: {
    ...TEMPLATE_FIELDS,
    // Where the blank PDF is in this ZIP, when it's there.
    pdfInExport: 'contracts',
    isDemo: 'contracts',
    ...times('contracts'),
  },
  contracts: {
    ...CONTRACT_FIELDS,
    templateFamilyId: 'id',
    // What went out, frozen when it was marked sent. Never holds Personal ID.
    sentValues: 'contracts',
    sentAt: 'contracts',
    isDemo: 'contracts',
    ...times('contracts'),
  },
  documents: {
    id: 'id',
    engagementId: 'id',
    documentType: 'documents',
    status: 'documents',
    receivedOn: 'documents',
    receivedVia: 'documents',
    sentToFinanceAt: 'documents',
    acceptedAt: 'documents',
    filePurgedAt: 'documents',
    financeNote: 'documents',
    // Whether the app holds the form's file right now.
    fileHeld: 'documents',
    // The file itself, its name and where it is in this ZIP: Tax and bank docs.
    fileName: 'tax_bank',
    fileInExport: 'tax_bank',
    isDemo: 'documents',
    ...times('documents'),
  },
  document_requirements: { contractType: 'documents', documentType: 'documents' },
  document_settings: {
    linkDays: 'documents',
    retentionYears: 'documents',
    retentionConfirmed: 'documents',
    lastPurgeAt: 'documents',
    updatedAt: 'documents',
  },
  reminder_settings: {
    paperworkDaysBefore: 'documents',
    contractDaysAfter: 'documents',
    digestOn: 'documents',
    updatedAt: 'documents',
  },
  drafts: {
    id: 'id',
    productionId: 'id',
    status: 'admin',
    createdVia: 'admin',
    proposal: 'admin',
    matchedPersonId: 'id',
    matchedAgentId: 'id',
    engagementId: 'id',
    decidedAt: 'admin',
    ...times('admin'),
  },
  staff: { id: 'id', name: 'admin', email: 'admin', role: 'admin', twoFactorEnabled: 'admin', ...times('admin') },
  role_access: { role: 'admin', fieldGroup: 'admin', level: 'admin', updatedAt: 'admin' },
  audit_log: {
    id: 'id',
    at: 'admin',
    actorId: 'admin',
    actorEmail: 'admin',
    action: 'admin',
    recordType: 'admin',
    recordId: 'admin',
    personId: 'admin',
    fieldGroup: 'admin',
    via: 'admin',
    detail: 'admin',
  },
} as const satisfies Record<ExportTableName, ExportFields>

function sees(grants: Grants, group: FieldGroup): boolean {
  return levelAtLeast(levelFor(grants, group), 'view')
}

/** The columns of a table this caller gets, in registry order. */
export function exportColumns(
  fields: ExportFields,
  opts: Pick<ExportOptions, 'grants' | 'isAdmin' | 'includeSensitive'>,
) {
  return Object.entries(fields)
    .filter(([, group]) => {
      if (group === 'id') return true
      if (group === 'admin') return opts.isAdmin
      if (!sees(opts.grants, group)) return false
      return opts.includeSensitive || !MASKED_GROUPS.has(group)
    })
    .map(([key]) => key)
}

/** A table is left out when the caller gets none of its non-id columns. */
function hasContent(fields: ExportFields, columns: readonly string[]): boolean {
  return columns.some((c) => fields[c] !== 'id')
}

function project(row: Row, columns: readonly string[]): Row {
  const out: Row = {}
  for (const c of columns) out[c] = row[c] ?? null
  return out
}

/** A safe, readable piece of a file name. */
export function slug(text: string, max = 40): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
  return s || 'file'
}

const EXTENSIONS: Record<FileMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }

interface BinaryFile {
  path: string
  data: Uint8Array
  /** Called once the file makes it into the ZIP. */
  onIncluded: () => void
}

export async function buildExport(db: Db, opts: ExportOptions): Promise<ExportResult> {
  const now = opts.now ?? new Date()
  const want = (group: FieldGroup) => sees(opts.grants, group)
  const wantSensitive = (group: FieldGroup) => opts.includeSensitive && want(group)

  // One consistent snapshot: a change made mid-export can't leave a contract
  // pointing at an engagement the file doesn't have.
  const raw = await db.transaction(
    async (tx) => ({
      seasons: await tx.select().from(season).orderBy(asc(season.startsOn), asc(season.id)),
      productions: await tx.select().from(production).orderBy(asc(production.rehearsalStart), asc(production.id)),
      people: await tx.select().from(person).orderBy(asc(person.legalName), asc(person.id)),
      agents: await tx.select().from(agent).orderBy(asc(agent.name), asc(agent.id)),
      engagements: await tx.select().from(engagement).orderBy(asc(engagement.createdAt), asc(engagement.id)),
      conflicts: await tx.select().from(conflict).orderBy(asc(conflict.startsOn), asc(conflict.id)),
      housingNeeds: await tx.select().from(housingPreference).orderBy(asc(housingPreference.id)),
      flights: await tx.select().from(flight).orderBy(asc(flight.scheduledDeparture), asc(flight.id)),
      flightAlerts: await tx.select().from(flightEvent).orderBy(asc(flightEvent.at), asc(flightEvent.id)),
      rentalCars: await tx.select().from(rentalCar).orderBy(asc(rentalCar.pickupAt), asc(rentalCar.id)),
      housingPlaces: await tx.select().from(housingUnit).orderBy(asc(housingUnit.name), asc(housingUnit.id)),
      housingRooms: await tx.select().from(housingRoom).orderBy(asc(housingRoom.unitId), asc(housingRoom.name)),
      housingStays: await tx
        .select()
        .from(housingAssignment)
        .orderBy(asc(housingAssignment.startsOn), asc(housingAssignment.id)),
      organization: await tx.select().from(organization),
      templates: await tx
        .select()
        .from(contractTemplate)
        .orderBy(asc(contractTemplate.name), asc(contractTemplate.version), asc(contractTemplate.id)),
      contracts: await tx.select().from(contract).orderBy(asc(contract.createdAt), asc(contract.id)),
      documents: await tx
        .select({ document, file: documentFile })
        .from(document)
        .leftJoin(documentFile, eq(documentFile.documentId, document.id))
        .orderBy(asc(document.engagementId), asc(document.documentType)),
      requirements: await tx
        .select()
        .from(documentRequirement)
        .orderBy(asc(documentRequirement.contractType), asc(documentRequirement.documentType)),
      documentSettings: await tx.select().from(documentSettings),
      reminderSettings: await tx.select().from(reminderSettings),
      drafts: opts.isAdmin
        ? await tx.select().from(engagementDraft).orderBy(asc(engagementDraft.createdAt), asc(engagementDraft.id))
        : [],
      staff: opts.isAdmin
        ? await tx
            .select({
              id: user.id,
              name: user.name,
              email: user.email,
              role: userRole.role,
              twoFactorEnabled: user.twoFactorEnabled,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            })
            .from(user)
            .leftJoin(userRole, eq(userRole.userId, user.id))
            .where(ne(user.id, GUEST_USER_ID))
            .orderBy(asc(user.email))
        : [],
      roleAccess: opts.isAdmin
        ? await tx.select().from(roleGrant).orderBy(asc(roleGrant.role), asc(roleGrant.fieldGroup))
        : [],
      audit: opts.isAdmin ? await tx.select().from(auditEvent).orderBy(asc(auditEvent.at), asc(auditEvent.id)) : [],
    }),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )

  const sensitiveReads: SensitiveRead[] = []
  const binaries: BinaryFile[] = []

  // People: masked fields are stored encrypted; decrypt only the ones going out.
  const key = fieldKey()
  const people: Row[] = raw.people.map((row) => {
    const record: Row = {
      ...toPersonRecord(row),
      isDemo: row.isDemo,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
    const groupsRead = new Set<FieldGroup>()
    for (const [field, spec] of Object.entries(PERSON_STORAGE)) {
      if (!('aad' in spec)) continue
      const group = PERSON_FIELDS[field as keyof typeof PERSON_FIELDS] as FieldGroup
      const stored = record[field]
      if (!wantSensitive(group) || typeof stored !== 'string') {
        record[field] = null
        continue
      }
      record[field] = decryptField(stored, spec.aad, key)
      groupsRead.add(group)
    }
    for (const group of groupsRead) {
      sensitiveReads.push({ personId: row.id, fieldGroup: group, recordType: 'person', recordId: row.id })
    }
    return record
  })

  // Readable folder names for held forms.
  const personById = new Map(raw.people.map((p) => [p.id, p]))
  const productionById = new Map(raw.productions.map((p) => [p.id, p]))
  const engagementById = new Map(raw.engagements.map((e) => [e.id, e]))

  const documents: Row[] = raw.documents.map(({ document: d, file }) => {
    const row: Row = { ...d, fileHeld: file !== null, fileName: null, fileInExport: null }
    const eng = engagementById.get(d.engagementId)
    if (file && wantSensitive('tax_bank') && eng) {
      const who = personById.get(eng.personId)?.legalName ?? 'person'
      const show = productionById.get(eng.productionId)?.title ?? 'production'
      const ext = EXTENSIONS[file.mime as FileMime] ?? 'bin'
      const path = `forms/${slug(who)}-${slug(show)}-${eng.id.slice(0, 8)}/${slug(DOCUMENT_TYPE_LABELS[d.documentType])}.${ext}`
      const personId = eng.personId
      binaries.push({
        path,
        data: decryptFile(file.data, d.id),
        onIncluded: () => {
          // The file name is tax_bank too: only read it for a form that goes out, and log it with the form.
          row.fileName = decryptField(file.fileNameEnc, FILE_NAME_AAD, key)
          row.fileInExport = path
          sensitiveReads.push({
            personId,
            fieldGroup: 'tax_bank',
            recordType: 'document_file',
            recordId: d.id,
            detail: { documentType: d.documentType },
          })
        },
      })
    }
    return row
  })

  const templates: Row[] = raw.templates.map((t) => {
    const row: Row = { ...t, pdfInExport: null }
    if (t.pdf && want('contracts')) {
      const path = `templates/${slug(t.name)}-v${t.version}-${t.id.slice(0, 8)}.pdf`
      binaries.push({ path, data: t.pdf, onIncluded: () => (row.pdfInExport = path) })
    }
    return row
  })

  const sources: Record<ExportTableName, Row[]> = {
    seasons: raw.seasons,
    productions: raw.productions,
    people,
    agents: raw.agents,
    engagements: raw.engagements,
    conflicts: raw.conflicts,
    housing_needs: raw.housingNeeds,
    flights: raw.flights,
    flight_alerts: raw.flightAlerts,
    rental_cars: raw.rentalCars,
    housing_places: raw.housingPlaces,
    housing_rooms: raw.housingRooms,
    housing_stays: raw.housingStays,
    organization: raw.organization,
    contract_templates: templates,
    contracts: raw.contracts,
    documents,
    document_requirements: raw.requirements,
    document_settings: raw.documentSettings,
    reminder_settings: raw.reminderSettings,
    drafts: raw.drafts,
    staff: raw.staff,
    role_access: raw.roleAccess,
    audit_log: raw.audit,
  }

  // Tables come first: they are the theater's records. Files fill what's left,
  // since each can still be opened from the app. README gets a fixed reserve.
  const maxBytes = opts.maxBytes ?? MAX_EXPORT_BYTES
  const README_RESERVE = Math.min(128 * 1024, Math.floor(maxBytes / 4))
  const budget = maxBytes - ZIP_OVERHEAD - README_RESERVE

  const tables: Table[] = []
  const columnsByTable = new Map<ExportTableName, string[]>()
  for (const { name } of EXPORT_TABLES) {
    const fields = EXPORT_FIELDS[name] as ExportFields
    const columns = exportColumns(fields, opts)
    if (!hasContent(fields, columns)) continue
    columnsByTable.set(name, columns)
    tables.push({ name, fields, rows: sources[name].map((r) => project(r, columns)) })
  }
  const csvEntry = (t: Table, rows = t.rows) =>
    prepareEntry({
      name: `csv/${t.name}.csv`,
      data: Buffer.from('\uFEFF' + toCsv(columnsByTable.get(t.name)!, rows), 'utf8'),
    })
  const csvEntries = new Map(tables.map((t) => [t.name, csvEntry(t)]))
  const csvBytes = () => [...csvEntries.values()].reduce((n, e) => n + entrySize(e), 0)

  // If the CSVs alone don't fit, the audit log, the one table that only grows,
  // keeps its newest rows and the README says how many older ones were left out.
  let auditRowsLeftOut = 0
  const audit = tables.find((t) => t.name === 'audit_log')
  if (csvBytes() > budget && audit) {
    const others = csvBytes() - entrySize(csvEntries.get('audit_log')!)
    if (others > budget) throw new ExportTooLargeError(others)
    let lo = 0
    let hi = audit.rows.length // rows to drop, oldest first
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (others + entrySize(csvEntry(audit, audit.rows.slice(mid))) <= budget) hi = mid
      else lo = mid + 1
    }
    auditRowsLeftOut = lo
    audit.rows = audit.rows.slice(lo)
    csvEntries.set('audit_log', csvEntry(audit))
  } else if (csvBytes() > budget) {
    throw new ExportTooLargeError(csvBytes())
  }
  let used = csvBytes()

  const data = {
    format: 'theatre-raleigh-company-management-export',
    version: 1,
    exportedAt: now.toISOString(),
    exportedBy: opts.exportedBy,
    includesSensitive: opts.includeSensitive,
    tables: Object.fromEntries(tables.map((t) => [t.name, t.rows])),
  }
  // data.json repeats the CSVs, so it is the first thing to go when space runs short.
  let dataEntry: ReturnType<typeof prepareEntry> | null = auditRowsLeftOut
    ? null
    : prepareEntry({ name: 'data.json', data: Buffer.from(JSON.stringify(data, null, 2), 'utf8') })
  if (dataEntry && used + entrySize(dataEntry) > budget) dataEntry = null
  if (dataEntry) used += entrySize(dataEntry)

  const fileEntries: ReturnType<typeof prepareEntry>[] = []
  const skippedFiles: ExportSummary['skippedFiles'] = []
  for (const b of binaries) {
    const entry = prepareEntry({ name: b.path, data: b.data })
    if (used + entrySize(entry) > budget) {
      skippedFiles.push({ path: b.path, bytes: b.data.length })
      continue
    }
    used += entrySize(entry)
    fileEntries.push(entry)
    b.onIncluded()
  }
  // Form and template rows only now know whether their file went out; rebuild
  // them so fileName, fileInExport and pdfInExport match. They grow by a few
  // cells at most, which the README reserve covers.
  let dataChanged = false
  for (const name of ['documents', 'contract_templates'] as const) {
    const t = tables.find((x) => x.name === name)
    if (!t) continue
    t.rows = sources[name].map((r) => project(r, columnsByTable.get(name)!))
    csvEntries.set(name, csvEntry(t))
    data.tables[name] = t.rows
    dataChanged = true
  }
  if (dataEntry && dataChanged) {
    dataEntry = prepareEntry({ name: 'data.json', data: Buffer.from(JSON.stringify(data, null, 2), 'utf8') })
  }

  const today = theatreToday(now)
  const fileName = `theatre-raleigh-export-${today}${opts.includeSensitive ? '-sensitive' : ''}.zip`
  const summaryBase = {
    fileName,
    includesSensitive: opts.includeSensitive,
    tables: tables.map((t) => ({ name: t.name, rows: t.rows.length })),
    files: fileEntries.length,
    skippedFiles,
    dataJson: dataEntry !== null,
    auditRowsLeftOut,
  }

  const textEntries = [
    prepareEntry({
      name: 'README.txt',
      data: Buffer.from(readme({ ...summaryBase, exportedBy: opts.exportedBy, now, columnsByTable }), 'utf8'),
    }),
    ...(dataEntry ? [dataEntry] : []),
    ...tables.map((t) => csvEntries.get(t.name)!),
  ]

  const zip = writeZip([...textEntries, ...fileEntries], now)
  if (zip.length > maxBytes) throw new ExportTooLargeError(zip.length)
  return { zip, summary: { ...summaryBase, bytes: zip.length }, sensitiveReads }
}

function readme(s: {
  fileName: string
  exportedBy: string
  now: Date
  includesSensitive: boolean
  tables: { name: ExportTableName; rows: number }[]
  files: number
  skippedFiles: { path: string; bytes: number }[]
  dataJson: boolean
  auditRowsLeftOut: number
  columnsByTable: Map<ExportTableName, string[]>
}): string {
  const label = (name: ExportTableName) => EXPORT_TABLES.find((t) => t.name === name)?.label ?? name
  const lines = [
    'Theatre Raleigh company management: full data export',
    '',
    `Exported ${s.now.toISOString()} by ${s.exportedBy}.`,
    s.includesSensitive
      ? 'This file INCLUDES sensitive details: dates of birth, home addresses, TSA/KTN and frequent-flyer numbers, and any tax and bank forms the app still held. Keep it somewhere safe and delete it when you are done.'
      : 'Sensitive details (dates of birth, home addresses, TSA/KTN and frequent-flyer numbers, and tax and bank forms) are NOT included. Export again with "Include sensitive details" to get them.',
    '',
    "What's inside",
    '- csv/: one spreadsheet per table, UTF-8. Opens in Excel, Numbers or Google Sheets.',
    ...(s.dataJson
      ? ['- data.json: the same rows, for loading into another system. Values are exactly as stored.']
      : []),
    '- templates/: blank contract forms uploaded to the app.',
    ...(s.includesSensitive
      ? ['- forms/: tax and bank forms the app still held, one folder per person and production.']
      : []),
    '',
    'Tables',
    ...s.tables.map((t) => `- csv/${t.name}.csv: ${label(t.name)} (${t.rows} ${t.rows === 1 ? 'row' : 'rows'})`),
    '',
    'Reading the data',
    '- Rows link by id: engagements.personId is a people.id, engagements.productionId a productions.id, and so on.',
    '- Money is in whole cents (weeklyPayCents 125000 is $1,250.00). Commission is a percent.',
    '- Dates are YYYY-MM-DD. Times are instants in UTC (ISO 8601, ending in Z).',
    '- In the CSVs, a text value that starts like a spreadsheet formula has an apostrophe in front so it opens as text.',
    '- Forms Finance accepted are deleted from the app on acceptance, so only their status and dates are here.',
    '',
    'Left out on purpose',
    '- Passwords, sign-in sessions, two-factor keys, connected-app tokens, upload link tokens, phone alert device keys and the flight feed’s subscriptions. They are how the app runs, not the theater’s records, and some would let whoever holds them in.',
    '- The pasted email behind each Claude draft. The draft’s proposal is in drafts.csv.',
  ]
  if (!s.dataJson || s.auditRowsLeftOut) {
    lines.push(
      '',
      'Shortened to fit one download',
      ...(s.dataJson ? [] : ['- data.json was left out. The CSVs hold every row it would have.']),
      ...(s.auditRowsLeftOut
        ? [
            `- The ${s.auditRowsLeftOut} oldest audit log entries were left out; audit_log.csv starts at the oldest entry that fit. They are still in the app.`,
          ]
        : []),
    )
  }
  if (s.skippedFiles.length) {
    lines.push(
      '',
      'Files too large for one download',
      'These were left out so the export fits in one download. Open each from the app:',
      ...s.skippedFiles.map((f) => `- ${f.path} (${Math.ceil(f.bytes / 1024)} KB)`),
    )
  }
  lines.push(
    '',
    'Columns',
    ...s.tables.map((t) => `- ${t.name}: ${s.columnsByTable.get(t.name)!.join(', ')}`),
    '',
    `Who can see what in the app: ${Object.values(FIELD_GROUP_LABELS).length} field groups, set per role (${Object.values(ROLE_LABELS).join(', ')}). See role_access.csv.`,
    '',
  )
  return lines.join('\r\n')
}
