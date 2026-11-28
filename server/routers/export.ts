import { TRPCError } from '@trpc/server'
import { exportInput } from '../../shared/export.js'
import { auditEvent } from '../db/schema.js'
import { buildExport } from '../export/build.js'
import { adminProcedure, router } from '../trpc.js'

export const exportRouter = router({
  /**
   * The full data export, as a ZIP. The Company Manager only: the guest demo
   * and the Claude connector can't call a mutation, and Finance isn't the
   * admin. Every export is logged, and with sensitive details, so is each
   * person whose masked values or held forms went into the file.
   */
  download: adminProcedure.input(exportInput).mutation(async ({ ctx, input }) => {
    let result
    try {
      result = await buildExport(ctx.db, {
        grants: ctx.grants,
        isAdmin: true,
        includeSensitive: input.includeSensitive,
        exportedBy: ctx.user.email,
      })
    } catch (error) {
      console.error('export failed', error)
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The export could not be built. Try again.' })
    }
    const { summary, sensitiveReads } = result
    // Nothing is handed over until the log has it.
    await ctx.db.transaction(async (tx) => {
      await tx.insert(auditEvent).values({
        actorId: ctx.user.id,
        actorEmail: ctx.user.email,
        action: 'export',
        recordType: 'export',
        via: 'app',
        detail: {
          includesSensitive: summary.includesSensitive,
          bytes: summary.bytes,
          tables: Object.fromEntries(summary.tables.map((t) => [t.name, t.rows])),
          files: summary.files,
          skippedFiles: summary.skippedFiles.length,
        },
      })
      if (sensitiveReads.length) {
        await tx.insert(auditEvent).values(
          sensitiveReads.map((r) => ({
            actorId: ctx.user.id,
            actorEmail: ctx.user.email,
            action: 'export' as const,
            recordType: r.recordType,
            recordId: r.recordId,
            personId: r.personId,
            fieldGroup: r.fieldGroup,
            via: 'app',
            detail: r.detail ?? null,
          })),
        )
      }
    })
    return { ...summary, base64: result.zip.toString('base64') }
  }),
})
