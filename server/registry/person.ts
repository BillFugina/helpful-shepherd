import type { MaskedPersonField, PersonField } from '../../shared/access.js'
import { encryptOptional, fieldKey } from '../crypto/fields.js'
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
  unionMemberId: { column: 'unionMemberId' },
  email: { column: 'email' },
  cell: { column: 'cell' },
  homeAirport: { column: 'homeAirport' },
  airportPrefs: { column: 'airportPrefs' },
  dob: { column: 'dobEnc', aad: 'person.dob' },
  homeStreet: { column: 'homeStreetEnc', aad: 'person.home_street' },
  homeCityStateZip: { column: 'homeCityStateZipEnc', aad: 'person.home_city_state_zip' },
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

type PersonInsert = typeof person.$inferInsert

/** A form's person fields, plaintext. Masked ones are encrypted on the way in. */
export type PersonInput = Partial<Record<Exclude<PersonField, 'id'>, string | null>>

/**
 * Turns form fields into column values, encrypting masked fields with their
 * column's AAD. Fields left undefined are left out, so an update touches only
 * what the form sent.
 */
export function personColumns(input: PersonInput, key: Buffer = fieldKey()): Partial<PersonInsert> {
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined) continue
    const spec = (PERSON_STORAGE as Record<string, { column: PersonColumn; aad?: string }>)[field]
    if (!spec || spec.column === 'id') continue
    out[spec.column] = spec.aad ? encryptOptional(value, spec.aad, key) : value
  }
  return out as Partial<PersonInsert>
}
