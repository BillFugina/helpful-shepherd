import { TRPCError } from '@trpc/server'
import { asc, eq } from 'drizzle-orm'
import { filterRecord } from '../../shared/access.js'
import { AGENT_FIELDS, agentFields, updateAgentInput } from '../../shared/roster.js'
import { agent } from '../db/schema.js'
import { createAgent } from '../roster/create.js'
import { agentRecord } from '../roster/records.js'
import { router, staffProcedure } from '../trpc.js'
import { auditChange, friendly, groupsOf, requireEdit, requireView, writtenKeys } from '../writes.js'

export const agentsRouter = router({
  list: staffProcedure.query(async ({ ctx }) => {
    requireView(ctx.grants, 'contact')
    const rows = await ctx.db.select().from(agent).orderBy(asc(agent.name))
    return rows.map((r) => filterRecord(agentRecord(r), AGENT_FIELDS, ctx.grants))
  }),

  create: staffProcedure.input(agentFields).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, groupsOf(writtenKeys(input, AGENT_FIELDS), AGENT_FIELDS))
    const id = await friendly(() => ctx.db.transaction((tx) => createAgent(tx, ctx.user, input, 'form')))
    return { id }
  }),

  update: staffProcedure.input(updateAgentInput).mutation(async ({ ctx, input }) => {
    const { id, ...changes } = input
    const keys = writtenKeys(changes, AGENT_FIELDS)
    requireEdit(ctx.grants, groupsOf(keys, AGENT_FIELDS))
    if (!keys.length) return { id }
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx.update(agent).set(changes).where(eq(agent.id, id)).returning({ id: agent.id })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That agent no longer exists.' })
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'agent',
          recordId: id,
          keys,
          fields: AGENT_FIELDS,
        })
        return { id }
      }),
    )
  }),
})
