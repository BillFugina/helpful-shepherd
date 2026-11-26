import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { localDate, THEATRE_TZ } from '../../shared/time.js'
import { DOCUMENT_STATUS_LABELS, DOCUMENT_TYPE_LABELS } from '../../shared/documents.js'
import { CONTRACT_TYPES } from '../../shared/roster.js'
import { COVERAGE_STATUS_LABELS } from '../../shared/travel.js'
import { loadAccess } from '../access.js'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import { appRouter } from '../routers/index.js'
import { connectorGrants, createCallerFactory, FORBIDDEN_REASONS, type SessionUser } from '../trpc.js'
import { canReviewDrafts, createDraft, listDrafts } from './drafts.js'

/**
 * The Claude connector's tools. Every read goes through the app's own tRPC
 * procedures with `via: 'connector'`, so the same role filter applies, minus
 * the field groups that never go over the connector (DOB, travel IDs, tax and
 * bank, housing address and door code). The one write is a draft that waits
 * for the Company Manager's review in the app. Every call is audited.
 */

export interface ToolEnv {
  db: Db
  user: SessionUser
  /** The connected app (OAuth client id), for the audit log. */
  clientId: string
}

export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

interface AuditNote {
  recordId?: string
  personId?: string
  /** Ids, dates and counts only. Never a name, an email or any other value. */
  detail?: Record<string, unknown>
}

interface ToolDef<S extends z.ZodType> {
  title: string
  description: string
  input: S
  readOnly: boolean
  run: (args: z.output<S>, env: ToolEnv) => Promise<{ data: unknown; audit?: AuditNote }>
}

const createCaller = createCallerFactory(appRouter)
const callerFor = (env: ToolEnv) => createCaller({ db: env.db, user: env.user, via: 'connector' })

const uuid = (what: string) => z.uuid().describe(`The ${what}'s id, from another tool's result.`)
const isoDate = z.iso.date()

function define<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def
}

const dollarsToCents = (d: number | null | undefined) => (d === null || d === undefined ? null : Math.round(d * 100))

const draftInput = z.object({
  productionId: uuid('production').describe('The production they accepted, from list_productions.'),
  emailText: z
    .string()
    .min(1)
    .max(20_000)
    .describe('The acceptance email exactly as pasted, so the reviewer can check the draft against it.'),
  person: z.object({
    legalName: z.string().min(1).max(160).describe('Legal name, as on their ID.'),
    preferredName: z.string().max(80).optional(),
    email: z.email().optional(),
    cell: z.string().max(40).optional(),
    homeAirport: z.string().max(8).optional().describe('Airport code, like LGA.'),
  }),
  agent: z
    .object({
      name: z.string().min(1).max(120),
      agency: z.string().max(160).optional(),
      email: z.email().optional(),
      phone: z.string().max(40).optional(),
    })
    .optional()
    .describe('Their agent, if the email names one.'),
  terms: z.object({
    role: z
      .string()
      .min(1)
      .max(160)
      .describe('Their role or job on the production, like "Ensemble" or "Lighting designer".'),
    contractType: z.enum(CONTRACT_TYPES).optional().describe('equity_itc, sdc or non_union, if the email says.'),
    weeklyPayDollars: z.number().min(0).max(1_000_000).optional(),
    commissionPercent: z.number().min(0).max(100).optional(),
    weeklyStipendDollars: z.number().min(0).max(1_000_000).optional(),
    travelProvided: z.boolean().optional(),
    carProvided: z.boolean().optional(),
    housingProvided: z.boolean().optional(),
    preferredArrival: isoDate.optional().describe('YYYY-MM-DD'),
    preferredDeparture: isoDate.optional().describe('YYYY-MM-DD'),
    scriptNeeded: z.boolean().optional(),
    notes: z.string().max(2000).optional(),
  }),
  conflicts: z
    .array(
      z.object({
        startsOn: isoDate.describe('YYYY-MM-DD'),
        endsOn: isoDate.describe('YYYY-MM-DD'),
        description: z.string().min(1).max(500),
      }),
    )
    .max(50)
    .optional()
    .describe('Dates they said they are unavailable.'),
})

export const CONNECTOR_TOOLS = {
  list_productions: define({
    title: 'List productions',
    description:
      'Every production with its id, season and dates (rehearsal, tech, opening, closing). Use it to find the productionId other tools need.',
    input: z.object({}),
    readOnly: true,
    run: async (_args, env) => {
      const rows = await callerFor(env).productions.list()
      return { data: rows, audit: { detail: { count: rows.length } } }
    },
  }),

  find_people: define({
    title: 'Find people',
    description:
      'Search people in the app by name (or email). Returns up to 10 matches with their personId. Use get_person for their productions.',
    input: z.object({ name: z.string().trim().min(1).max(100).describe('A name or part of one.') }),
    readOnly: true,
    run: async (args, env) => {
      const rows = await callerFor(env).people.search({ q: args.name })
      return { data: rows, audit: { detail: { count: rows.length } } }
    },
  }),

  get_person: define({
    title: 'Get a person',
    description:
      "One person's profile and every production they have been on (engagementId, role, status). Use person_card for one production's travel and conflicts.",
    input: z.object({ personId: uuid('person') }),
    readOnly: true,
    run: async (args, env) => {
      const data = await callerFor(env).people.get({ id: args.personId })
      return { data, audit: { recordId: args.personId, personId: args.personId } }
    },
  }),

  person_card: define({
    title: 'Person card',
    description:
      "One person's card for one production: contacts, role and deal terms their role can see, agent, conflicts, flights, rental car and housing (place, room and dates, never the address or door code). Takes an engagementId (one person on one production).",
    input: z.object({ engagementId: uuid('engagement') }),
    readOnly: true,
    run: async (args, env) => {
      const caller = callerFor(env)
      const [itinerary, deal] = await Promise.all([
        caller.travel.forEngagement({ engagementId: args.engagementId }),
        caller.engagements.get({ id: args.engagementId }),
      ])
      const data = {
        person: itinerary.person,
        production: deal.production,
        seasonName: deal.seasonName,
        engagement: deal.engagement,
        agent: deal.agent,
        conflicts: deal.conflicts,
        flights: itinerary.flights,
        cars: itinerary.cars,
        housing: itinerary.housing
          ? {
              coverage: itinerary.housing.coverage,
              need: itinerary.housing.need,
              stays: itinerary.housing.stays.map((s) => ({
                place: s.unit.name ?? null,
                room: s.room.name ?? null,
                firstNight: s.startsOn ?? null,
                moveOutDay: s.endsOn ?? null,
              })),
              warnings: itinerary.housing.warnings.map((w) => w.message),
            }
          : undefined,
        preferences: itinerary.preferences,
      }
      return { data, audit: { recordId: args.engagementId, personId: itinerary.person.id } }
    },
  }),

  production_roster: define({
    title: 'Production roster',
    description:
      "Everyone on one production: name, role, pipeline status (offer accepted through departed), agent, and how many conflicts they've listed.",
    input: z.object({ productionId: uuid('production') }),
    readOnly: true,
    run: async (args, env) => {
      const caller = callerFor(env)
      const p = await caller.productions.get({ id: args.productionId })
      const dashboard = await caller.seasons.dashboard({ id: p.seasonId })
      const production = dashboard.productions.find((x) => x.id === args.productionId)
      if (!production) throw new TRPCError({ code: 'NOT_FOUND', message: 'That production no longer exists.' })
      return {
        data: { ...production, seasonName: p.seasonName },
        audit: { recordId: args.productionId, detail: { count: production.engagements.length } },
      }
    },
  }),

  production_conflicts: define({
    title: 'Production conflicts',
    description:
      "Everyone's listed conflicts (dates they're unavailable) on one production, soonest first. Upcoming only unless includePast is true.",
    input: z.object({
      productionId: uuid('production'),
      includePast: z.boolean().optional().describe('Also list conflicts that have already ended.'),
    }),
    readOnly: true,
    run: async (args, env) => {
      const from = args.includePast ? undefined : localDate(new Date(), THEATRE_TZ)
      const rows = await callerFor(env).productions.conflicts({ id: args.productionId, from })
      return { data: rows, audit: { recordId: args.productionId, detail: { count: rows.length } } }
    },
  }),

  contract_status: define({
    title: 'Contract status',
    description:
      'Where every contract on one production stands: for each person, their contract type and each contract (draft, sent with the date, or signed with the date), plus who has none prepared yet. Read-only; contracts are prepared, sent and marked signed in the app.',
    input: z.object({ productionId: uuid('production') }),
    readOnly: true,
    run: async (args, env) => {
      const d = await callerFor(env).contracts.byProduction({ productionId: args.productionId })
      const people = d.engagements.map((e) => ({
        engagementId: e.id,
        name: e.preferredName ?? e.legalName ?? null,
        role: e.role,
        contractType: e.contractType,
        contracts: e.contracts.map((c) => ({
          contractId: c.id,
          template: c.template.name,
          status: c.status,
          sentOn: c.sentOn,
          signedOn: c.signedOn,
        })),
      }))
      const all = people.flatMap((p) => p.contracts)
      const data = {
        production: d.production.title,
        counts: {
          notPrepared: people.filter((p) => p.contractType !== 'non_union' && !p.contracts.length).length,
          draft: all.filter((c) => c.status === 'draft').length,
          sent: all.filter((c) => c.status === 'sent').length,
          signed: all.filter((c) => c.status === 'signed').length,
        },
        people,
      }
      return { data, audit: { recordId: args.productionId, detail: { count: all.length } } }
    },
  }),

  missing_documents: define({
    title: 'Missing documents',
    description:
      'The paperwork checklist on one production: for each person, which forms (W-4, NC-4, I-9, W-9, Equity deferral, direct deposit, bank verification) are missing, received, with Finance, or done, and any note Finance left when it sent a form back. Statuses only; this never returns a form or anything on one. Read-only; forms are uploaded, sent to Finance and accepted in the app.',
    input: z.object({ productionId: uuid('production') }),
    readOnly: true,
    run: async (args, env) => {
      const d = await callerFor(env).documents.overview({ productionId: args.productionId })
      const people = d.engagements.map((e) => ({
        engagementId: e.id,
        name: e.preferredName ?? e.legalName ?? null,
        role: e.role,
        contractType: e.contractType,
        complete: e.summary.complete,
        forms: e.checklist
          .filter((c) => c.required)
          .map((c) => ({
            form: DOCUMENT_TYPE_LABELS[c.documentType],
            status: DOCUMENT_STATUS_LABELS[c.status],
            receivedOn: c.receivedOn,
            financeNote: c.financeNote,
          })),
      }))
      const sum = (k: 'missing' | 'received' | 'withFinance' | 'flagged') =>
        d.engagements.reduce((n, e) => n + e.summary[k], 0)
      const data = {
        production: d.production.title,
        counts: {
          peopleComplete: people.filter((p) => p.complete).length,
          peopleOutstanding: people.filter((p) => !p.complete).length,
          missing: sum('missing'),
          waitingToSend: sum('received'),
          withFinance: sum('withFinance'),
          sentBack: sum('flagged'),
        },
        people,
      }
      return { data, audit: { recordId: args.productionId, detail: { count: people.length } } }
    },
  }),

  housing_plan: define({
    title: 'Housing plan',
    description:
      'Where everyone on one production stays: for each person, the place and room with first night and move-out day, the nights they need (from their flights, else the dates they asked for, else the production dates), and anything still missing: no room yet, missing nights, or no dates to go on. Warnings cover shared bathrooms, floors and flights outside a stay. Place and room names only, never an address, door code or how to get in. Read-only; rooms are assigned in the app.',
    input: z.object({ productionId: uuid('production') }),
    readOnly: true,
    run: async (args, env) => {
      const d = await callerFor(env).housing.plan({ productionId: args.productionId })
      const people = d.people.map((p) => ({
        engagementId: p.engagementId,
        name: p.name,
        role: p.role,
        housingProvided: p.housingProvided,
        status: COVERAGE_STATUS_LABELS[p.coverage.status],
        needs: p.need ? { firstNight: p.need.from, moveOutDay: p.need.to, basedOn: p.need.source } : null,
        missingNights: p.coverage.missing.map((r) => ({ firstNight: r.from, moveOutDay: r.to })),
        stays: p.stays.map((s) => ({
          place: s.unitName,
          room: s.roomName,
          firstNight: s.startsOn,
          moveOutDay: s.endsOn,
        })),
        warnings: p.warnings,
      }))
      const data = { production: d.production.title, counts: d.counts, people }
      return { data, audit: { recordId: args.productionId, detail: { count: people.length } } }
    },
  }),

  arrivals_board: define({
    title: 'Arrivals board',
    description:
      'Who lands and who leaves on a travel day, with live flight status, rental cars, where each person sleeps that night (place and room only), people expected with no flight logged yet, and flight alerts. Dates are theatre-local (Raleigh). Omit date for today; the result also gives the next travel day.',
    input: z.object({ date: isoDate.optional().describe('YYYY-MM-DD. Leave out for today.') }),
    readOnly: true,
    run: async (args, env) => {
      const board = await callerFor(env).arrivals.board({ date: args.date })
      const data = {
        date: board.date,
        today: board.today,
        arrivals: board.arrivals,
        departures: board.departures,
        arrivingNoFlight: board.arrivingNoFlight,
        leavingNoFlight: board.leavingNoFlight,
        alerts: board.alerts,
        nextTravelDay: board.nextTravelDay,
        firstTravelDay: board.firstTravelDay,
      }
      return {
        data,
        audit: { detail: { date: board.date, arrivals: board.arrivals.length, departures: board.departures.length } },
      }
    },
  }),

  draft_engagement_from_email: define({
    title: 'Draft a new engagement from an acceptance email',
    description:
      'Turns an acceptance email into a draft person and engagement for the Company Manager to review in the app. Read the email, fill in only what it actually says, and pass the email text unchanged. Nothing is saved to the roster until someone reviews the draft and saves it in the app (Drafts page). Do not include dates of birth, TSA or KTN numbers, frequent flyer numbers, tax or bank details, or addresses; the app collects those itself.',
    input: draftInput,
    readOnly: false,
    run: async (args, env) => {
      const access = await loadAccess(env.db, env.user.id)
      if (!access) throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.noRole })
      if (!canReviewDrafts(connectorGrants(access.grants))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Your role can view the roster but not add to it.' })
      }
      const t = args.terms
      const draft = await createDraft(env.db, env.user, {
        productionId: args.productionId,
        emailText: args.emailText,
        proposal: {
          person: {
            legalName: args.person.legalName,
            preferredName: args.person.preferredName ?? null,
            email: args.person.email ?? null,
            cell: args.person.cell ?? null,
            homeAirport: args.person.homeAirport?.toUpperCase() ?? null,
            airportPrefs: null,
          },
          agent: args.agent
            ? {
                name: args.agent.name,
                agency: args.agent.agency ?? null,
                email: args.agent.email ?? null,
                phone: args.agent.phone ?? null,
              }
            : null,
          terms: {
            role: t.role,
            contractType: t.contractType ?? null,
            weeklyPayCents: dollarsToCents(t.weeklyPayDollars),
            commissionPercent: t.commissionPercent ?? null,
            weeklyStipendCents: dollarsToCents(t.weeklyStipendDollars),
            travelProvided: t.travelProvided,
            carProvided: t.carProvided,
            housingProvided: t.housingProvided,
            preferredArrival: t.preferredArrival ?? null,
            preferredDeparture: t.preferredDeparture ?? null,
            scriptNeeded: t.scriptNeeded,
            notes: t.notes ?? null,
          },
          conflicts: args.conflicts ?? [],
        },
      })
      return {
        data: {
          draftId: draft.id,
          status: 'pending',
          returningPerson: draft.matchedPersonId !== null,
          agentAlreadyInApp: draft.matchedAgentId !== null,
          next: 'Saved as a draft only. Review and save it in the app on the Drafts page.',
        },
        // Draft creation writes its own audit event; this one records the tool call.
        audit: { recordId: draft.id, personId: draft.matchedPersonId ?? undefined },
      }
    },
  }),

  list_drafts: define({
    title: 'List drafts',
    description: 'Drafts waiting for review in the app (made from acceptance emails), newest first.',
    input: z.object({}),
    readOnly: true,
    run: async (_args, env) => {
      const access = await loadAccess(env.db, env.user.id)
      if (!access) throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_REASONS.noRole })
      if (!canReviewDrafts(connectorGrants(access.grants))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Your role can view the roster but not add to it.' })
      }
      const rows = await listDrafts(env.db, 'pending')
      const data = rows.map((r) => {
        const p = r.proposal as {
          person?: { legalName?: string; preferredName?: string | null }
          terms?: { role?: string }
        }
        return {
          draftId: r.id,
          createdAt: r.createdAt,
          production: r.productionTitle,
          name: p.person?.preferredName ?? p.person?.legalName ?? null,
          role: p.terms?.role ?? null,
          returningPerson: r.matchedPersonId !== null,
        }
      })
      return { data, audit: { detail: { count: data.length } } }
    },
  }),
} as const

export type ConnectorToolName = keyof typeof CONNECTOR_TOOLS

const FRIENDLY_FORBIDDEN: Record<string, string> = {
  [FORBIDDEN_REASONS.twoFactorRequired]: 'Two-factor sign-in is off for this account. Turn it on in the app first.',
  [FORBIDDEN_REASONS.noRole]: 'This account has no role in the app yet, so there is nothing to show.',
  [FORBIDDEN_REASONS.adminOnly]: 'Only the Company Manager can see that.',
  [FORBIDDEN_REASONS.readOnlyConnector]: 'The connector can only read, and make drafts for review.',
}

function errorText(error: unknown): { text: string; outcome: string } {
  if (error instanceof TRPCError) {
    if (error.code === 'FORBIDDEN')
      return { text: FRIENDLY_FORBIDDEN[error.message] ?? error.message, outcome: 'denied' }
    if (error.code === 'NOT_FOUND') return { text: error.message, outcome: 'not_found' }
    if (error.code === 'BAD_REQUEST' || error.code === 'CONFLICT') {
      const cause = error.cause
      const detail =
        cause instanceof z.ZodError
          ? cause.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
          : ''
      return { text: detail ? `That didn't check out: ${detail}` : error.message, outcome: 'invalid' }
    }
  }
  if (error instanceof z.ZodError) {
    return {
      text: `That didn't check out: ${error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`,
      outcome: 'invalid',
    }
  }
  console.error('[connector] tool failed:', error)
  return { text: 'Something went wrong in the app. Try again in a moment.', outcome: 'error' }
}

/**
 * Runs one tool for the connected person, writes the audit event, and shapes
 * the answer for Claude. Failures come back as tool errors Claude can relay,
 * and are audited too.
 */
export async function runConnectorTool(env: ToolEnv, name: ConnectorToolName, rawArgs: unknown): Promise<ToolResult> {
  const def = CONNECTOR_TOOLS[name] as ToolDef<z.ZodType>
  const base = {
    actorId: env.user.id,
    actorEmail: env.user.email,
    action: def.readOnly ? ('read' as const) : ('create' as const),
    recordType: 'connector_tool',
    via: 'connector' as const,
  }
  try {
    const args = def.input.parse(rawArgs ?? {})
    const runAndAudit = async (db: Db) => {
      const { data, audit } = await def.run(args, { ...env, db })
      await recordAudit(db, {
        ...base,
        recordId: audit?.recordId,
        personId: audit?.personId,
        detail: { tool: name, client: env.clientId, ...audit?.detail },
      })
      return data
    }
    // A write and its audit events commit together, so a failed audit can't
    // leave a saved draft behind an error (and a retry can't duplicate it).
    const data = def.readOnly ? await runAndAudit(env.db) : await env.db.transaction((tx) => runAndAudit(tx))
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] }
  } catch (error) {
    const { text, outcome } = errorText(error)
    await recordAudit(env.db, { ...base, detail: { tool: name, client: env.clientId, outcome } }).catch((e) =>
      console.error('[connector] audit failed:', e),
    )
    return { content: [{ type: 'text', text }], isError: true }
  }
}
