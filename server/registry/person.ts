import type { MaskedPersonField, PersonField } from '../../shared/access.js'
import type { person } from '../db/schema.js'

type PersonRow = typeof person.$inferSelect
type PersonColumn = keyof PersonRow

/**
 * Where each field in PERSON_FIELDS (shared/access.ts) is stored. Encrypted
 * fields also carry the name bound into their ciphertext (the AAD), so the
 * seed, Reveal and any future writer all use the same one.
 *
 * PERSON_FIELDS owns which group a field is in; this owns where it lives. The
 * checks below fail the build if the two disagree or a column goes unmapped.
 */
export const PERSON_STORAGE = {
  id: { column: 'id' },
  legalName: { column: 'legalName' },
  preferredName: { column: 'preferredName' },
  email: { column: 'email' },
  cell: { column: 'cell' },
  homeAirport: { column: 'homeAirport' },
  dob: { column: 'dobEnc', aad: 'person.dob' },
  tsaKtn: { column: 'tsaKtnEnc', aad: 'person.tsa_ktn' },
  frequentFlyer: { column: 'frequentFlyerEnc', aad: 'person.frequent_flyer' },
} as const satisfies Record<PersonField, { column: PersonColumn; aad?: string }>

type Storage = typeof PERSON_STORAGE
type EncryptedPersonField = { [K in PersonField]: Storage[K] extends { aad: string } ? K : never }[PersonField]

/** Columns that are bookkeeping, not fields anyone reads. */
type InternalColumn = 'isDemo' | 'createdAt' | 'updatedAt'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
// Every masked field is encrypted at rest, and only those are.
const maskedAreEncrypted: Same<MaskedPersonField, EncryptedPersonField> = true
// Every column is either mapped to a field or listed as internal, so a new
// column forces a decision about its field group.
const everyColumnMapped: Same<Exclude<PersonColumn, Storage[PersonField]['column'] | InternalColumn>, never> = true
void maskedAreEncrypted
void everyColumnMapped

export type PersonRecord = { [K in PersonField]: PersonRow[Storage[K]['column']] }

/** A person row named the way the field registry names it. Masked fields hold ciphertext here and must go through filterRecord. */
export function toPersonRecord(row: PersonRow): PersonRecord {
  const out: Record<string, unknown> = {}
  for (const [field, spec] of Object.entries(PERSON_STORAGE)) out[field] = row[spec.column]
  return out as PersonRecord
}
