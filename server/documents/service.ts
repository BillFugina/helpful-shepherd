import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import {
  buildChecklist,
  DEFAULT_SETTINGS,
  summarize,
  type ChecklistItem,
  type DocumentRow,
  type DocumentType,
} from '../../shared/documents.js'
import { ENGAGEMENT_FIELDS, type ContractType } from '../../shared/roster.js'
import { recordAudit } from '../audit.js'
import { fieldKey } from '../crypto/fields.js'
import type { Db } from '../db/client.js'
import { document, documentFile, documentRequirement, documentSettings, engagement, production } from '../db/schema.js'
import type { SessionUser } from '../trpc.js'
import { auditChange } from '../writes.js'

// ---------------------------------------------------------------------------
// File encryption
// ---------------------------------------------------------------------------

/**
 * Files get their own key, derived from the field key, so the two are never
 * used for the same job. AES-256-GCM with the document's id as associated
 * data: a file copied onto another document won't decrypt.
 */
let cachedFileKey: Buffer | undefined
function fileKey(): Buffer {
  cachedFileKey ??= Buffer.from(hkdfSync('sha256', fieldKey(), Buffer.alloc(0), 'document-file-v1', 32))
  return cachedFileKey
}

export function encryptFile(bytes: Uint8Array, documentId: string, key = fileKey()): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`document:${documentId}`, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

export function decryptFile(stored: Buffer, documentId: string, key = fileKey()): Buffer {
  const iv = stored.subarray(0, 12)
  const tag = stored.subarray(12, 28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(`document:${documentId}`, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()])
}

/** The column name is the associated data for an encrypted file name. */
export const FILE_NAME_AAD = 'document_file.file_name'

// ---------------------------------------------------------------------------
// Upload link tokens
// ---------------------------------------------------------------------------

export function newLinkToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Only this is stored. A leaked database can't be turned back into working links. */
export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Settings and requirements
// ---------------------------------------------------------------------------

export async function loadSettings(db: Db) {
  const [row] = await db.select().from(documentSettings).where(eq(documentSettings.id, 1)).limit(1)
  return (
    row ?? {
      id: 1,
      linkDays: DEFAULT_SETTINGS.linkDays,
      retentionYears: DEFAULT_SETTINGS.retentionYears,
      retentionConfirmed: false,
      lastPurgeAt: null,
    }
  )
}

export async function loadRequirements(db: Db): Promise<Map<ContractType, DocumentType[]>> {
  const rows = await db.select().from(documentRequirement)
  const out = new Map<ContractType, DocumentType[]>()
  for (const r of rows) out.set(r.contractType, [...(out.get(r.contractType) ?? []), r.documentType])
  return out
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export function toDocumentRow(d: typeof document.$inferSelect, hasFile: boolean): DocumentRow {
  return {
    id: d.id,
    documentType: d.documentType,
    status: d.status,
    hasFile,
    receivedOn: d.receivedOn,
    receivedVia: d.receivedVia,
    sentToFinanceAt: d.sentToFinanceAt,
    acceptedAt: d.acceptedAt,
    filePurgedAt: d.filePurgedAt,
    financeNote: d.financeNote,
  }
}

/** Checklists for these engagements, keyed by engagement id. */
export async function loadChecklists(
  db: Db,
  engagements: readonly { id: string; contractType: ContractType }[],
): Promise<Map<string, ChecklistItem[]>> {
  const out = new Map<string, ChecklistItem[]>()
  if (!engagements.length) return out
  const requirements = await loadRequirements(db)
  const rows = await db
    .select({ document, fileId: documentFile.documentId })
    .from(document)
    .leftJoin(documentFile, eq(documentFile.documentId, document.id))
    .where(
      inArray(
        document.engagementId,
        engagements.map((e) => e.id),
      ),
    )
  const byEngagement = new Map<string, DocumentRow[]>()
  for (const r of rows) {
    const list = byEngagement.get(r.document.engagementId) ?? []
    list.push(toDocumentRow(r.document, r.fileId !== null))
    byEngagement.set(r.document.engagementId, list)
  }
  for (const e of engagements) {
    out.set(e.id, buildChecklist(requirements.get(e.contractType) ?? [], byEngagement.get(e.id) ?? []))
  }
  return out
}

// ---------------------------------------------------------------------------
// Moving things along
// ---------------------------------------------------------------------------

/**
 * When every required form is accepted or not needed, a signed engagement
 * moves to Paperwork complete. Only from Contract signed: paperwork never
 * skips a contract that hasn't been signed, and never moves anyone back.
 */
export async function completeIfDone(tx: Db, user: SessionUser | null, engagementId: string, via?: 'upload_link') {
  const [eng] = await tx.select().from(engagement).where(eq(engagement.id, engagementId)).for('update').limit(1)
  if (!eng || eng.pipelineStatus !== 'contract_signed') return false
  const checklist = (await loadChecklists(tx, [eng])).get(eng.id) ?? []
  const summary = summarize(checklist)
  if (!summary.total || !summary.complete) return false
  await tx.update(engagement).set({ pipelineStatus: 'paperwork_complete' }).where(eq(engagement.id, engagementId))
  const detail = { from: eng.pipelineStatus, to: 'paperwork_complete', because: 'documents' }
  if (user) {
    await auditChange(tx, user, {
      action: 'update',
      recordType: 'engagement',
      recordId: engagementId,
      personId: eng.personId,
      keys: ['pipelineStatus'],
      fields: ENGAGEMENT_FIELDS,
      detail,
    })
  } else {
    await recordAudit(tx, {
      actorId: null,
      action: 'update',
      recordType: 'engagement',
      recordId: engagementId,
      personId: eng.personId,
      fieldGroup: 'general',
      via: via ?? 'system',
      detail: { ...detail, fields: ['pipelineStatus'] },
    })
  }
  return true
}

// ---------------------------------------------------------------------------
// Deleting files
// ---------------------------------------------------------------------------

export type PurgeReason = 'accepted' | 'removed' | 'not_needed' | 'retention'

/** Deletes one document's file, if it has one, and logs it. Returns whether a file was there. */
export async function purgeFile(
  tx: Db,
  documentId: string,
  personId: string,
  reason: PurgeReason,
  actor: { user: SessionUser | null; via?: 'app' | 'system' },
): Promise<boolean> {
  const gone = await tx.delete(documentFile).where(eq(documentFile.documentId, documentId)).returning({
    id: documentFile.documentId,
  })
  if (!gone.length) return false
  await tx.update(document).set({ filePurgedAt: new Date() }).where(eq(document.id, documentId))
  await recordAudit(tx, {
    actorId: actor.user?.id ?? null,
    actorEmail: actor.user?.email ?? null,
    action: 'delete',
    recordType: 'document_file',
    recordId: documentId,
    personId,
    fieldGroup: 'tax_bank',
    via: actor.via ?? 'app',
    detail: { reason },
  })
  return true
}

/** How often the retention backstop runs at most. */
export const PURGE_EVERY_MS = 60 * 60 * 1000

/**
 * The backstop: deletes any file still held once its production closed more
 * than the retention period ago (a production with no closing date counts
 * from when the file came in). Runs when staff open the Documents pages, at
 * most once an hour, so it needs no scheduler. Returns how many it deleted.
 */
export async function purgeExpired(db: Db, now = new Date(), force = false): Promise<number> {
  const settings = await loadSettings(db)
  if (!force) {
    // Claim the run atomically so two requests don't both do it.
    const claimed = await db
      .update(documentSettings)
      .set({ lastPurgeAt: now })
      .where(
        and(
          eq(documentSettings.id, 1),
          or(
            sql`${documentSettings.lastPurgeAt} is null`,
            lt(documentSettings.lastPurgeAt, new Date(now.getTime() - PURGE_EVERY_MS)),
          ),
        ),
      )
      .returning({ id: documentSettings.id })
    if (!claimed.length) return 0
  }
  const years = settings.retentionYears
  const due = await db
    .select({ documentId: document.id, personId: engagement.personId })
    .from(documentFile)
    .innerJoin(document, eq(document.id, documentFile.documentId))
    .innerJoin(engagement, eq(engagement.id, document.engagementId))
    .innerJoin(production, eq(production.id, engagement.productionId))
    .where(
      and(
        isNotNull(documentFile.documentId),
        sql`coalesce(${production.closing}::timestamptz, ${documentFile.createdAt}) + make_interval(years => ${years}) < ${now.toISOString()}::timestamptz`,
      ),
    )
  let deleted = 0
  for (const d of due) {
    await db.transaction(async (tx) => {
      if (await purgeFile(tx, d.documentId, d.personId, 'retention', { user: null, via: 'system' })) deleted++
    })
  }
  return deleted
}
