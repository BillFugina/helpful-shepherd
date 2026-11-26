import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import {
  blankFields,
  resolveContract,
  type ContractContext,
  type OrganizationValues,
  type ResolvedField,
  type TemplateFormat,
} from '../../shared/contracts.js'
import { localDate, THEATRE_TZ } from '../../shared/time.js'
import { decryptField, fieldKey } from '../crypto/fields.js'
import type { Db } from '../db/client.js'
import { contract, contractTemplate, engagement, organization, person, production, season } from '../db/schema.js'
import { PERSON_STORAGE } from '../registry/person.js'

export const EMPTY_ORGANIZATION: OrganizationValues = {
  name: null,
  street: null,
  cityStateZip: null,
  phone: null,
  email: null,
  signerName: null,
  ein: null,
  unemploymentNumber: null,
  equityEmployerAgreement: null,
}

export async function loadOrganization(db: Db): Promise<OrganizationValues> {
  const [row] = await db.select().from(organization).limit(1)
  if (!row) return EMPTY_ORGANIZATION
  return {
    name: row.name,
    street: row.street,
    cityStateZip: row.cityStateZip,
    phone: row.phone,
    email: row.email,
    signerName: row.signerName,
    ein: row.ein,
    unemploymentNumber: row.unemploymentNumber,
    equityEmployerAgreement: row.equityEmployerAgreement,
  }
}

/** Today in Raleigh, YYYY-MM-DD. */
export function theatreToday(now = new Date()): string {
  return localDate(now, THEATRE_TZ)
}

function decrypt(stored: string | null, field: 'homeStreet' | 'homeCityStateZip'): string | null {
  return stored ? decryptField(stored, PERSON_STORAGE[field].aad, fieldKey()) : null
}

export type ContractRow = typeof contract.$inferSelect
export type TemplateRow = typeof contractTemplate.$inferSelect

export async function contractOrThrow(db: Db, id: string, opts: { lock?: boolean } = {}) {
  const q = db
    .select({ contract, template: contractTemplate })
    .from(contract)
    .innerJoin(contractTemplate, eq(contractTemplate.id, contract.templateId))
    .where(eq(contract.id, id))
    .limit(1)
  const [row] = opts.lock ? await q.for('update', { of: contract }) : await q
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That contract no longer exists.' })
  return row
}

/**
 * Everything a contract for this engagement is filled from. Home address is
 * decrypted here and never leaves the server except inside a downloaded PDF.
 */
export async function contractContext(db: Db, engagementId: string, today: string) {
  const [row] = await db
    .select({ engagement, person, production, seasonName: season.name })
    .from(engagement)
    .innerJoin(person, eq(person.id, engagement.personId))
    .innerJoin(production, eq(production.id, engagement.productionId))
    .innerJoin(season, eq(season.id, production.seasonId))
    .where(eq(engagement.id, engagementId))
    .limit(1)
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That engagement no longer exists.' })
  const c: ContractContext = {
    today,
    employer: await loadOrganization(db),
    person: {
      legalName: row.person.legalName,
      unionMemberId: row.person.unionMemberId,
      email: row.person.email,
      cell: row.person.cell,
      homeStreet: decrypt(row.person.homeStreetEnc, 'homeStreet'),
      homeCityStateZip: decrypt(row.person.homeCityStateZipEnc, 'homeCityStateZip'),
    },
    engagement: {
      role: row.engagement.role,
      weeklyPayCents: row.engagement.weeklyPayCents,
      weeklyStipendCents: row.engagement.weeklyStipendCents,
      feeCents: row.engagement.feeCents,
    },
    production: {
      title: row.production.title,
      rehearsalStart: row.production.rehearsalStart,
      opening: row.production.opening,
      closing: row.production.closing,
      venueName: row.production.venueName,
      venueCapacity: row.production.venueCapacity,
      topTicketCents: row.production.topTicketCents,
      scheduledPerformances: row.production.scheduledPerformances,
      rehearsalLocation: row.production.rehearsalLocation,
      rehearsalCallTime: row.production.rehearsalCallTime,
    },
    season: { name: row.seasonName },
  }
  return { context: c, engagement: row.engagement, person: row.person, production: row.production }
}

/**
 * A contract's fields as they stand. A draft is filled live; a sent or signed
 * one shows what went out, with Personal ID read fresh (it's never stored).
 */
export async function resolvedFields(
  db: Db,
  row: { contract: ContractRow; template: TemplateRow },
): Promise<{ fields: ResolvedField[]; context: Awaited<ReturnType<typeof contractContext>> }> {
  const today = row.contract.sentOn ?? theatreToday()
  const loaded = await contractContext(db, row.contract.engagementId, today)
  const template = { format: row.template.format as TemplateFormat, body: row.template.body }
  let fields = resolveContract(template, loaded.context, row.contract.overrides)
  const frozen = row.contract.sentValues
  if (frozen) {
    fields = fields.map((f) => (f.personal || frozen[f.name] === undefined ? f : { ...f, value: frozen[f.name]! }))
  }
  return { fields, context: loaded }
}

/** The values kept when a contract is marked sent: everything but Personal ID. */
export function valuesToFreeze(fields: readonly ResolvedField[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) if (!f.personal) out[f.name] = f.value
  return out
}

/** What the app shows for a field: Personal ID values stay on the server, only whether they're filled. */
export function forDisplay(fields: readonly ResolvedField[]) {
  const blanks = new Set(blankFields(fields).map((f) => f.name))
  return fields.map((f) => ({
    name: f.name,
    label: f.label,
    kind: f.kind,
    options: f.options ? [...f.options] : undefined,
    value: f.personal ? null : f.value,
    filled: Boolean(f.value.trim()),
    required: f.required,
    personal: f.personal,
    computed: f.computed,
    overridden: f.overridden,
    blank: blanks.has(f.name),
  }))
}
