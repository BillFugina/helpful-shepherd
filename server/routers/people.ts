import { TRPCError } from '@trpc/server'
import { asc, eq } from 'drizzle-orm'
import { filterRecord, levelAtLeast, levelFor, PERSON_FIELDS } from '../../shared/access.js'
import { revealPersonFieldInput, type RevealablePersonField } from '../../shared/schemas.js'
import { recordAudit } from '../audit.js'
import { decryptField, fieldKey } from '../crypto/fields.js'
import { person } from '../db/schema.js'
import { router, staffProcedure } from '../trpc.js'

/** Where each revealable field is stored, and the column name bound into its ciphertext. */
const ENCRYPTED_COLUMNS = {
  dob: { column: 'dobEnc', aad: 'person.dob' },
  tsaKtn: { column: 'tsaKtnEnc', aad: 'person.tsa_ktn' },
  frequentFlyer: { column: 'frequentFlyerEnc', aad: 'person.frequent_flyer' },
} as const satisfies Record<RevealablePersonField, { column: keyof typeof person.$inferSelect; aad: string }>

type PersonRow = typeof person.$inferSelect

/** The record as the field registry names it. Masked fields carry ciphertext here and never leave unfiltered. */
function toRecord(row: PersonRow) {
  return {
    id: row.id,
    legalName: row.legalName,
    preferredName: row.preferredName,
    email: row.email,
    cell: row.cell,
    homeAirport: row.homeAirport,
    dob: row.dobEnc,
    tsaKtn: row.tsaKtnEnc,
    frequentFlyer: row.frequentFlyerEnc,
  }
}

export const peopleRouter = router({
  list: staffProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(person).orderBy(asc(person.legalName))
    return rows.map((row) => filterRecord(toRecord(row), PERSON_FIELDS, ctx.grants))
  }),

  /** The only way a masked value leaves the server. Checks the grant and logs the view. */
  reveal: staffProcedure.input(revealPersonFieldInput).mutation(async ({ ctx, input }) => {
    const group = PERSON_FIELDS[input.field]
    if (!levelAtLeast(levelFor(ctx.grants, group), 'view')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Your role has no access to this field.' })
    }
    const { column, aad } = ENCRYPTED_COLUMNS[input.field]
    const [row] = await ctx.db.select().from(person).where(eq(person.id, input.personId)).limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND' })

    await recordAudit(ctx.db, {
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'reveal',
      recordType: 'person',
      recordId: row.id,
      personId: row.id,
      fieldGroup: group,
      detail: { field: input.field },
    })

    const stored = row[column]
    return { value: stored ? decryptField(stored, aad, fieldKey()) : null }
  }),
})
