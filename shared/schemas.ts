import { z } from 'zod'
import { ACCESS_LEVELS, FIELD_GROUPS, ROLES, type MaskedPersonField } from './access.js'

/** Person fields whose values only come back through Reveal. */
export const REVEALABLE_PERSON_FIELDS = ['dob', 'homeStreet', 'homeCityStateZip', 'tsaKtn', 'frequentFlyer'] as const
export type RevealablePersonField = (typeof REVEALABLE_PERSON_FIELDS)[number]

// Compile-time check: this list is exactly the person fields in a masked group,
// so adding a masked field to PERSON_FIELDS without listing it here fails the build.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const revealableMatchesMasked: Same<RevealablePersonField, MaskedPersonField> = true
void revealableMatchesMasked

export const revealPersonFieldInput = z.object({
  personId: z.uuid(),
  field: z.enum(REVEALABLE_PERSON_FIELDS),
})

export const setGrantInput = z.object({
  role: z.enum(ROLES),
  fieldGroup: z.enum(FIELD_GROUPS),
  level: z.enum(ACCESS_LEVELS),
  /** Second confirmation for Travel ID and Tax and bank docs. */
  confirmSensitive: z.boolean().default(false),
})

export const auditListInput = z.object({
  personId: z.uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
})
