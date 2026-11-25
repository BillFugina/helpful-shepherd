import { and, eq, sql } from 'drizzle-orm'
import type { FieldGroup } from '../../shared/access.js'
import { parseImportRow } from '../../shared/import.js'
import { importRowsInput, type ImportColumn } from '../../shared/roster.js'
import type { Db } from '../db/client.js'
import { agent, engagement, person } from '../db/schema.js'
import { createAgent, createEngagement, createPerson, requireProduction } from '../roster/create.js'
import { router, staffProcedure } from '../trpc.js'
import { asUserError, friendly, requireEdit } from '../writes.js'

export interface ImportRowResult {
  /** 1-based, counting data rows (the header isn't row 1). */
  row: number
  status: 'add' | 'skip' | 'error'
  name: string
  person?: 'new' | 'existing'
  agent?: 'new' | 'existing' | 'none'
  messages: string[]
}

const CONTACT_COLUMNS: ImportColumn[] = [
  'email',
  'cell',
  'homeAirport',
  'agentName',
  'agency',
  'agentEmail',
  'agentPhone',
]
const PAY_COLUMNS: ImportColumn[] = ['weeklyPay', 'commissionPercent', 'weeklyStipend']

/** Thrown to roll back a dry run after it has done all the work. */
class DryRunRollback extends Error {}

/** A returning person: same email, or failing that the one person with the same legal name. */
async function findPerson(db: Db, legalName: string, email: string | null | undefined) {
  if (email) {
    const [byEmail] = await db
      .select({ id: person.id })
      .from(person)
      .where(eq(sql`lower(${person.email})`, email.toLowerCase()))
      .limit(1)
    if (byEmail) return { id: byEmail.id, ambiguous: false }
  }
  const byName = await db
    .select({ id: person.id, email: person.email })
    .from(person)
    .where(eq(sql`lower(${person.legalName})`, legalName.toLowerCase()))
    .limit(2)
  if (byName.length > 1) return { id: null, ambiguous: true }
  // A same-name person with a different email is someone else.
  const only = byName[0]
  if (only && (!email || !only.email)) return { id: only.id, ambiguous: false }
  return { id: null, ambiguous: false }
}

async function findAgent(db: Db, name: string, email: string | null | undefined, agency: string | null | undefined) {
  if (email) {
    const [byEmail] = await db
      .select({ id: agent.id })
      .from(agent)
      .where(eq(sql`lower(${agent.email})`, email.toLowerCase()))
      .limit(1)
    if (byEmail) return byEmail.id
  }
  const [byName] = await db
    .select({ id: agent.id })
    .from(agent)
    .where(
      and(
        eq(sql`lower(${agent.name})`, name.toLowerCase()),
        agency ? eq(sql`lower(coalesce(${agent.agency}, ''))`, agency.toLowerCase()) : undefined,
      ),
    )
    .limit(1)
  return byName?.id ?? null
}

export const importRouter = router({
  /**
   * The one-time spreadsheet import. A dry run does every step inside a
   * transaction and rolls it back, so the preview is exactly what an import
   * would do. A real run writes only if no row has an error.
   */
  rows: staffProcedure.input(importRowsInput).mutation(async ({ ctx, input }) => {
    const present = new Set<ImportColumn>()
    for (const r of input.rows) for (const [k, v] of Object.entries(r)) if (v?.trim()) present.add(k as ImportColumn)
    const groups: FieldGroup[] = ['general']
    if (CONTACT_COLUMNS.some((c) => present.has(c))) groups.push('contact')
    if (PAY_COLUMNS.some((c) => present.has(c))) groups.push('pay_terms')
    requireEdit(ctx.grants, groups)

    const results: ImportRowResult[] = []
    const run = async (tx: Db) => {
      await requireProduction(tx, input.productionId)
      const seenPeople = new Set<string>()
      for (const [i, raw] of input.rows.entries()) {
        const parsed = parseImportRow(raw)
        const name = raw.legalName?.trim() || '(no name)'
        if (!parsed.ok) {
          results.push({ row: i + 1, status: 'error', name, messages: parsed.errors })
          continue
        }
        const { person: p, agent: a, terms } = parsed.value
        // Savepoint per row, so one row's database error can't spoil the rest of the preview.
        const result = await tx
          .transaction(async (row) => {
            const found = await findPerson(row, p.legalName, p.email)
            if (found.ambiguous) {
              return {
                row: i + 1,
                status: 'error',
                name,
                messages: ['More than one person in the app has this name. Add their email to the row to say which.'],
              } satisfies ImportRowResult
            }
            let personId = found.id
            if (personId && seenPeople.has(personId)) {
              return {
                row: i + 1,
                status: 'skip',
                name,
                messages: ['Same person as an earlier row.'],
              } satisfies ImportRowResult
            }
            if (personId) {
              const [already] = await row
                .select({ id: engagement.id })
                .from(engagement)
                .where(and(eq(engagement.personId, personId), eq(engagement.productionId, input.productionId)))
                .limit(1)
              if (already) {
                seenPeople.add(personId)
                return {
                  row: i + 1,
                  status: 'skip',
                  name,
                  person: 'existing',
                  messages: ['Already on this production.'],
                } satisfies ImportRowResult
              }
            }
            const personState = personId ? 'existing' : 'new'
            personId ??= await createPerson(row, ctx.user, p, 'import')
            seenPeople.add(personId)
            let agentId: string | null = null
            let agentState: 'new' | 'existing' | 'none' = 'none'
            if (a) {
              agentId = await findAgent(row, a.name, a.email, a.agency)
              agentState = agentId ? 'existing' : 'new'
              agentId ??= await createAgent(row, ctx.user, a, 'import')
            }
            await createEngagement(
              row,
              ctx.user,
              { productionId: input.productionId, personId, agentId, terms, conflicts: [] },
              'import',
            )
            return {
              row: i + 1,
              status: 'add',
              name,
              person: personState,
              agent: agentState,
              messages: [],
            } satisfies ImportRowResult
          })
          .catch((error: unknown) => {
            const e = friendlyMessage(error)
            return { row: i + 1, status: 'error', name, messages: [e] } satisfies ImportRowResult
          })
        results.push(result)
      }
      if (input.dryRun || results.some((r) => r.status === 'error')) throw new DryRunRollback()
    }

    try {
      await friendly(() => ctx.db.transaction((tx) => run(tx)))
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error
    }
    const hasErrors = results.some((r) => r.status === 'error')
    return {
      imported: !input.dryRun && !hasErrors,
      counts: {
        add: results.filter((r) => r.status === 'add').length,
        skip: results.filter((r) => r.status === 'skip').length,
        error: results.filter((r) => r.status === 'error').length,
      },
      results,
    }
  }),
})

function friendlyMessage(error: unknown): string {
  const message = (asUserError(error) as { message?: unknown })?.message
  return typeof message === 'string' && message.length < 200 ? message : 'This row could not be saved.'
}
