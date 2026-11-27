import { DOCUMENT_TYPES, type DocumentType } from '../../shared/documents.js'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import { uploadLink } from '../db/schema.js'
import { appOrigin } from '../env.js'
import { hashLinkToken, loadSettings, newLinkToken } from './service.js'

/**
 * Makes an upload link for these forms. Only a hash of the token is stored;
 * the full address comes back once, to whoever asked for it.
 */
export async function issueLink(
  db: Db,
  /** Who asked for it. Null for an automatic reminder. */
  user: { id: string; email: string } | null,
  eng: { id: string; personId: string },
  documentTypes: readonly DocumentType[],
) {
  const settings = await loadSettings(db)
  const token = newLinkToken()
  const expiresAt = new Date(Date.now() + settings.linkDays * 24 * 60 * 60 * 1000)
  const types = DOCUMENT_TYPES.filter((t) => documentTypes.includes(t))
  const [link] = await db
    .insert(uploadLink)
    .values({
      engagementId: eng.id,
      tokenHash: hashLinkToken(token),
      documentTypes: types,
      expiresAt,
      createdBy: user?.id ?? null,
    })
    .returning({ id: uploadLink.id })
  await recordAudit(db, {
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? null,
    via: user ? 'app' : 'system',
    action: 'create',
    recordType: 'upload_link',
    recordId: link!.id,
    personId: eng.personId,
    fieldGroup: 'documents',
    detail: { documentTypes: types, expiresAt: expiresAt.toISOString() },
  })
  return { id: link!.id, url: `${appOrigin()}/upload/${token}`, expiresAt }
}
