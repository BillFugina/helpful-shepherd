/**
 * The roster: seasons, productions, agents, engagements (one person's deal for
 * one production) and their conflicts. Shared by the server, which enforces
 * the field registries below, and the client, which uses the labels and the
 * input schemas. Source: Ash's PRD (Nov 24, 2026) and the build plan's data
 * model.
 */
import { z } from 'zod'
import type { FieldMap } from './access.js'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** A season belongs to one program, so the children's theater can come in later beside the main stage. */
export const PROGRAMS = ['main_stage', 'childrens_theatre'] as const
export type Program = (typeof PROGRAMS)[number]
export const PROGRAM_LABELS: Record<Program, string> = {
  main_stage: 'Main stage',
  childrens_theatre: "Children's theatre",
}

export const CONTRACT_TYPES = ['equity_itc', 'sdc', 'non_union'] as const
export type ContractType = (typeof CONTRACT_TYPES)[number]
export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  equity_itc: 'Equity ITC',
  sdc: 'SDC',
  non_union: 'Non-union',
}

/** The PRD's stages, in order. */
export const PIPELINE_STATUSES = [
  'offer_accepted',
  'contract_sent',
  'contract_signed',
  'paperwork_complete',
  'travel_booked',
  'arrived',
  'departed',
] as const
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number]
export const PIPELINE_LABELS: Record<PipelineStatus, string> = {
  offer_accepted: 'Offer accepted',
  contract_sent: 'Contract sent',
  contract_signed: 'Contract signed',
  paperwork_complete: 'Paperwork complete',
  travel_booked: 'Travel booked',
  arrived: 'Arrived',
  departed: 'Departed',
}

// ---------------------------------------------------------------------------
// Field registries: which group each field belongs to. As with PERSON_FIELDS,
// a field missing here never leaves the server, and writing a field needs
// 'edit' on its group.
// ---------------------------------------------------------------------------

export const SEASON_FIELDS = {
  id: 'id',
  name: 'general',
  program: 'general',
  startsOn: 'general',
  endsOn: 'general',
} as const satisfies FieldMap

export const PRODUCTION_FIELDS = {
  id: 'id',
  seasonId: 'id',
  title: 'general',
  rehearsalStart: 'general',
  techStart: 'general',
  opening: 'general',
  closing: 'general',
  performanceSchedule: 'general',
  // What the union contracts ask about the run.
  venueName: 'general',
  venueCapacity: 'general',
  topTicketCents: 'general',
  scheduledPerformances: 'general',
  rehearsalLocation: 'general',
  rehearsalCallTime: 'general',
} as const satisfies FieldMap

/** Agents are contact details, per the plan's Contact group ("cell, email, agent"). */
export const AGENT_FIELDS = {
  id: 'id',
  name: 'contact',
  agency: 'contact',
  email: 'contact',
  phone: 'contact',
} as const satisfies FieldMap

export const ENGAGEMENT_FIELDS = {
  id: 'id',
  personId: 'id',
  productionId: 'id',
  // General
  role: 'general',
  contractType: 'general',
  pipelineStatus: 'general',
  travelProvided: 'general',
  carProvided: 'general',
  housingProvided: 'general',
  preferredArrival: 'general',
  preferredDeparture: 'general',
  scriptNeeded: 'general',
  compAllotment: 'general',
  notes: 'general',
  // Contact: who represents them on this deal.
  agentId: 'contact',
  // Pay terms
  weeklyPayCents: 'pay_terms',
  commissionPercent: 'pay_terms',
  weeklyStipendCents: 'pay_terms',
  // A flat fee, for SDC directors and choreographers.
  feeCents: 'pay_terms',
} as const satisfies FieldMap

export const CONFLICT_FIELDS = {
  id: 'id',
  engagementId: 'id',
  startsOn: 'general',
  endsOn: 'general',
  description: 'general',
} as const satisfies FieldMap

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const isoDate = z.iso.date()
export const optionalDate = isoDate.nullable().optional()
export const trimmed = (max: number) => z.string().trim().min(1).max(max)
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v))

/** Checks that each present pair of dates is in order. */
export function datesInOrder<T extends Record<string, unknown>>(
  value: T,
  ctx: z.RefinementCtx,
  keys: readonly (keyof T & string)[],
): void {
  const present = keys.filter((k) => typeof value[k] === 'string')
  for (let i = 1; i < present.length; i++) {
    const a = present[i - 1]!
    const b = present[i]!
    if ((value[a] as string) > (value[b] as string)) {
      ctx.addIssue({ code: 'custom', path: [b], message: `Must be on or after ${a}.` })
    }
  }
}

export const seasonFields = z.object({
  name: trimmed(120),
  program: z.enum(PROGRAMS),
  startsOn: isoDate,
  endsOn: isoDate,
})
export const createSeasonInput = seasonFields
  .extend({ program: seasonFields.shape.program.default('main_stage') })
  .superRefine((v, ctx) => datesInOrder(v, ctx, ['startsOn', 'endsOn']))
export const updateSeasonInput = z
  .object({ id: z.uuid() })
  .extend(seasonFields.partial().shape)
  .superRefine((v, ctx) => datesInOrder(v, ctx, ['startsOn', 'endsOn']))

const PRODUCTION_DATE_ORDER = ['rehearsalStart', 'techStart', 'opening', 'closing'] as const
export const productionFields = z.object({
  title: trimmed(160),
  rehearsalStart: optionalDate,
  techStart: optionalDate,
  opening: optionalDate,
  closing: optionalDate,
  performanceSchedule: optionalText(2000),
  venueName: optionalText(160),
  venueCapacity: z.number().int().min(1).max(100_000).nullable().optional(),
  topTicketCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
  scheduledPerformances: z.number().int().min(1).max(1000).nullable().optional(),
  rehearsalLocation: optionalText(200),
  rehearsalCallTime: optionalText(20),
})
export const createProductionInput = z
  .object({ seasonId: z.uuid() })
  .extend(productionFields.shape)
  .superRefine((v, ctx) => datesInOrder(v, ctx, PRODUCTION_DATE_ORDER))
export const updateProductionInput = z
  .object({ id: z.uuid() })
  .extend(productionFields.partial().shape)
  .superRefine((v, ctx) => datesInOrder(v, ctx, PRODUCTION_DATE_ORDER))

export const agentFields = z.object({
  name: trimmed(120),
  agency: optionalText(160),
  email: z
    .email()
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  phone: optionalText(40),
})
export const updateAgentInput = z.object({ id: z.uuid() }).extend(agentFields.partial().shape)

/** Person fields a form can write. Masked ones are plaintext here and encrypted on the server. */
export const personFields = z.object({
  legalName: trimmed(160),
  preferredName: optionalText(80),
  unionMemberId: optionalText(40),
  email: z
    .email()
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  cell: optionalText(40),
  homeAirport: optionalText(8),
  airportPrefs: optionalText(500),
  dob: optionalDate,
  homeStreet: optionalText(200),
  homeCityStateZip: optionalText(200),
  tsaKtn: optionalText(40),
  frequentFlyer: optionalText(500),
})
export const updatePersonInput = z.object({ id: z.uuid() }).extend(personFields.partial().shape)

const cents = z.number().int().min(0).max(100_000_000)

/** Deal terms with no defaults, so a partial update leaves unsent fields alone. */
const termsBase = z.object({
  role: trimmed(160),
  contractType: z.enum(CONTRACT_TYPES),
  pipelineStatus: z.enum(PIPELINE_STATUSES),
  weeklyPayCents: cents.nullable().optional(),
  // null means no commission.
  commissionPercent: z.number().min(0).max(100).nullable().optional(),
  weeklyStipendCents: cents.nullable().optional(),
  feeCents: cents.nullable().optional(),
  travelProvided: z.boolean(),
  carProvided: z.boolean(),
  housingProvided: z.boolean(),
  preferredArrival: optionalDate,
  preferredDeparture: optionalDate,
  scriptNeeded: z.boolean(),
  compAllotment: z.number().int().min(0).max(20),
  notes: optionalText(2000),
})

/** Deal terms for a new engagement, shared by the fast-entry form and the import. */
export const engagementTerms = termsBase.extend({
  pipelineStatus: termsBase.shape.pipelineStatus.default('offer_accepted'),
  travelProvided: z.boolean().default(false),
  carProvided: z.boolean().default(false),
  housingProvided: z.boolean().default(false),
  scriptNeeded: z.boolean().default(false),
  compAllotment: termsBase.shape.compAllotment.default(2),
})

export const conflictFields = z.object({
  startsOn: isoDate,
  endsOn: isoDate,
  description: trimmed(500),
})
const conflictInOrder = (v: { startsOn?: string; endsOn?: string }, ctx: z.RefinementCtx) =>
  datesInOrder(v, ctx, ['startsOn', 'endsOn'])
export const conflictInput = conflictFields.superRefine(conflictInOrder)
export const addConflictInput = z
  .object({ engagementId: z.uuid() })
  .extend(conflictFields.shape)
  .superRefine(conflictInOrder)

/** The person on a new engagement: someone already in the app, or a new person. */
export const personChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), personId: z.uuid() }),
  z.object({ kind: z.literal('new'), person: personFields }),
])

/** The agent on a new engagement: none, one already in the app, or a new one. */
export const agentChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('existing'), agentId: z.uuid() }),
  z.object({ kind: z.literal('new'), agent: agentFields }),
])

/**
 * The fast-entry form: everything in an acceptance email, in one save. Person,
 * agent, engagement and conflicts land together or not at all.
 */
export const quickCreateEngagementInput = z
  .object({
    productionId: z.uuid(),
    person: personChoice,
    agent: agentChoice,
    terms: engagementTerms,
    conflicts: z.array(conflictInput).max(50).default([]),
    // Set when the form was prefilled from a Claude connector draft.
    draftId: z.uuid().optional(),
  })
  .superRefine((v, ctx) => datesInOrder(v.terms, ctx, ['preferredArrival', 'preferredDeparture']))

export const updateEngagementInput = z
  .object({ id: z.uuid(), agentId: z.uuid().nullable().optional() })
  .extend(termsBase.partial().shape)
  .superRefine((v, ctx) => datesInOrder(v, ctx, ['preferredArrival', 'preferredDeparture']))

export const setPipelineStatusInput = z.object({ id: z.uuid(), status: z.enum(PIPELINE_STATUSES) })

// ---------------------------------------------------------------------------
// Spreadsheet import. The client parses the CSV and maps its columns; the
// server validates each row again and imports them in one transaction.
// ---------------------------------------------------------------------------

/** Columns the import can fill, in the order the mapping screen shows them. */
export const IMPORT_COLUMNS = [
  'legalName',
  'preferredName',
  'email',
  'cell',
  'homeAirport',
  'role',
  'contractType',
  'weeklyPay',
  'commissionPercent',
  'weeklyStipend',
  'agentName',
  'agency',
  'agentEmail',
  'agentPhone',
  'travelProvided',
  'carProvided',
  'housingProvided',
  'preferredArrival',
  'preferredDeparture',
  'pipelineStatus',
  'notes',
] as const
export type ImportColumn = (typeof IMPORT_COLUMNS)[number]

export const IMPORT_COLUMN_LABELS: Record<ImportColumn, string> = {
  legalName: 'Legal name (required)',
  preferredName: 'Preferred name',
  email: 'Email',
  cell: 'Cell',
  homeAirport: 'Home airport',
  role: 'Role (required)',
  contractType: 'Contract type (required)',
  weeklyPay: 'Weekly pay',
  commissionPercent: 'Agent commission %',
  weeklyStipend: 'Weekly stipend',
  agentName: 'Agent name',
  agency: 'Agency',
  agentEmail: 'Agent email',
  agentPhone: 'Agent phone',
  travelProvided: 'Travel provided',
  carProvided: 'Rental car provided',
  housingProvided: 'Housing provided',
  preferredArrival: 'Preferred arrival',
  preferredDeparture: 'Preferred departure',
  pipelineStatus: 'Status',
  notes: 'Notes',
}

export const importRowsInput = z.object({
  productionId: z.uuid(),
  /** Each row maps an import column to the raw cell text. */
  rows: z
    .array(z.partialRecord(z.enum(IMPORT_COLUMNS), z.string().max(2000)))
    .min(1)
    .max(500),
  /** When true, nothing is written: the server only reports what it would do. */
  dryRun: z.boolean().default(true),
})
