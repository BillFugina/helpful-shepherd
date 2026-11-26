/**
 * The Claude connector's draft engagements: what Claude proposes from a pasted
 * acceptance email, before the Company Manager reviews and saves it in the app.
 * Shared by the server (which validates and stores drafts) and the client
 * (which prefills the fast entry form from one).
 */
import { z } from 'zod'
import {
  agentFields,
  CONTRACT_TYPES,
  conflictInput,
  datesInOrder,
  optionalDate,
  optionalText,
  personFields,
  trimmed,
} from './roster.js'

const cents = z.number().int().min(0).max(100_000_000)

/**
 * Only the person fields a draft may carry. DOB and travel IDs never come in
 * over the connector, so they aren't here at all.
 */
export const draftPerson = personFields.pick({
  legalName: true,
  preferredName: true,
  email: true,
  cell: true,
  homeAirport: true,
  airportPrefs: true,
})

/** Deal terms as far as an email says them. Anything left out stays blank for the reviewer. */
export const draftTerms = z
  .object({
    role: trimmed(160),
    contractType: z.enum(CONTRACT_TYPES).nullable().optional(),
    weeklyPayCents: cents.nullable().optional(),
    commissionPercent: z.number().min(0).max(100).nullable().optional(),
    weeklyStipendCents: cents.nullable().optional(),
    travelProvided: z.boolean().optional(),
    carProvided: z.boolean().optional(),
    housingProvided: z.boolean().optional(),
    preferredArrival: optionalDate,
    preferredDeparture: optionalDate,
    scriptNeeded: z.boolean().optional(),
    compAllotment: z.number().int().min(0).max(20).optional(),
    notes: optionalText(2000),
  })
  .superRefine((v, ctx) => datesInOrder(v, ctx, ['preferredArrival', 'preferredDeparture']))

/** What a draft holds. Stored as JSON on the draft row and validated again when read. */
export const draftProposal = z.object({
  person: draftPerson,
  agent: agentFields.nullable(),
  terms: draftTerms,
  conflicts: z.array(conflictInput).max(50),
})
export type DraftProposal = z.infer<typeof draftProposal>
