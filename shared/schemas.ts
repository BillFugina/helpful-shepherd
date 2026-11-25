import { z } from 'zod'
import { ACCESS_LEVELS, FIELD_GROUPS, ROLES } from './access.js'

/** Person fields whose values only come back through Reveal. */
export const REVEALABLE_PERSON_FIELDS = ['dob', 'tsaKtn', 'frequentFlyer'] as const
export type RevealablePersonField = (typeof REVEALABLE_PERSON_FIELDS)[number]

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
