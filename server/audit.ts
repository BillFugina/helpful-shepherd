import type { AuditAction, FieldGroup } from '../shared/access.js'
import type { Db } from './db/client.js'
import { auditEvent } from './db/schema.js'

export interface AuditInput {
  actorId: string | null
  actorEmail?: string | null
  action: AuditAction
  recordType?: string
  recordId?: string
  personId?: string
  fieldGroup?: FieldGroup
  via?: 'app' | 'connector' | 'system'
  /** Field names or other context. Never put a sensitive value here. */
  detail?: Record<string, unknown>
}

/** Appends one event to the audit log. The table itself refuses updates and deletes. */
export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  await db.insert(auditEvent).values({
    actorId: input.actorId,
    actorEmail: input.actorEmail ?? null,
    action: input.action,
    recordType: input.recordType ?? null,
    recordId: input.recordId ?? null,
    personId: input.personId ?? null,
    fieldGroup: input.fieldGroup ?? null,
    via: input.via ?? 'app',
    detail: input.detail ?? null,
  })
}
