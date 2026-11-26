import { TRPCError } from '@trpc/server'
import { and, asc, count, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { z } from 'zod'
import { isGuestUserId, levelAtLeast, levelFor, type FieldGroup, type Grants } from '../../shared/access.js'
import {
  createLinkInput,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  documentRef,
  FILE_KINDS,
  flagInput,
  formsToRemind,
  linkToken,
  linkUploadInput,
  MAX_FILE_BYTES,
  OPEN_FOR_UPLOAD,
  requirementsInput,
  settingsInput,
  sniffMime,
  summarize,
  UPLOAD_LIMITS,
  uploadByHandInput,
  type DocumentType,
} from '../../shared/documents.js'
import { recordAudit } from '../audit.js'
import { renderText } from '../contracts/pdf.js'
import { loadOrganization, theatreToday } from '../contracts/service.js'
import { decryptField, encryptField, fieldKey } from '../crypto/fields.js'
import type { Db } from '../db/client.js'
import {
  document,
  documentFile,
  documentRequirement,
  documentSettings,
  engagement,
  person,
  production,
  uploadLink,
} from '../db/schema.js'
import {
  completeIfDone,
  decryptFile,
  encryptFile,
  FILE_NAME_AAD,
  hashLinkToken,
  loadChecklists,
  loadSettings,
  newLinkToken,
  purgeExpired,
  purgeFile,
} from '../documents/service.js'
import {
  lastReminders,
  MAX_BULK_REMINDERS,
  REMINDER_GAP_MS,
  REMINDER_RECORD,
  reminderEmail,
} from '../documents/reminders.js'
import { deliveryMode, sendEmail, type Delivery } from '../email/send.js'
import { appOrigin } from '../env.js'
import { adminProcedure, publicProcedure, router, staffProcedure, type SessionUser } from '../trpc.js'
import { friendly, requireEdit, requireView } from '../writes.js'

const sees = (grants: Grants, group: FieldGroup) => levelAtLeast(levelFor(grants, group), 'view')

/** Finance's actions: review on both the checklist and the files. */
function requireReview(grants: Grants) {
  for (const group of ['documents', 'tax_bank'] as const) {
    if (!levelAtLeast(levelFor(grants, group), 'review')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Only Finance can accept a form or send one back.' })
    }
  }
}

async function engagementOrThrow(db: Db, engagementId: string) {
  const [row] = await db
    .select({
      id: engagement.id,
      personId: engagement.personId,
      contractType: engagement.contractType,
      isDemo: engagement.isDemo,
    })
    .from(engagement)
    .where(eq(engagement.id, engagementId))
    .limit(1)
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That engagement no longer exists.' })
  return row
}

/** The form's row, made if it isn't there yet, locked for the rest of the transaction. */
async function lockDocument(
  tx: Db,
  eng: { id: string; isDemo: boolean },
  documentType: DocumentType,
): Promise<typeof document.$inferSelect> {
  await tx
    .insert(document)
    .values({ engagementId: eng.id, documentType, isDemo: eng.isDemo })
    .onConflictDoNothing({ target: [document.engagementId, document.documentType] })
  const [row] = await tx
    .select()
    .from(document)
    .where(and(eq(document.engagementId, eng.id), eq(document.documentType, documentType)))
    .for('update')
    .limit(1)
  return row!
}

async function hasFile(tx: Db, documentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: documentFile.documentId })
    .from(documentFile)
    .where(eq(documentFile.documentId, documentId))
    .limit(1)
  return Boolean(row)
}

/** One event on the checklist (no values, just what changed). */
async function auditStatus(
  tx: Db,
  user: SessionUser | null,
  doc: { id: string; documentType: DocumentType },
  personId: string,
  detail: Record<string, unknown>,
  via?: 'upload_link',
) {
  await recordAudit(tx, {
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? null,
    action: 'update',
    recordType: 'document',
    recordId: doc.id,
    personId,
    fieldGroup: 'documents',
    via: via ?? 'app',
    detail: { documentType: doc.documentType, ...detail },
  })
}

function decodeFile(base64: string): { bytes: Buffer; mime: keyof typeof FILE_KINDS } {
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'That file is empty.' })
  if (bytes.length > MAX_FILE_BYTES) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That file is over 3 MB. Try a smaller scan or photo.' })
  }
  const mime = sniffMime(bytes)
  if (!mime) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Send a PDF, or a JPEG or PNG photo of the form.' })
  return { bytes, mime }
}

async function checkRoom(tx: Db, documentId: string) {
  if (await hasFile(tx, documentId)) return // a replacement doesn't add a file
  const [held] = await tx.select({ n: count() }).from(documentFile)
  if ((held?.n ?? 0) >= UPLOAD_LIMITS.filesHeld) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'The app is holding as many forms as it can right now. Ask Finance to accept the ones waiting.',
    })
  }
}

/** Stores (or replaces) a form's file and marks it received. */
async function storeFile(
  tx: Db,
  doc: typeof document.$inferSelect,
  file: { bytes: Buffer; mime: string; fileName: string },
  by: { user: SessionUser | null; via: 'company_manager' | 'upload_link' },
) {
  const values = {
    data: encryptFile(file.bytes, doc.id),
    fileNameEnc: encryptField(file.fileName, FILE_NAME_AAD, fieldKey()),
    mime: file.mime,
    bytes: file.bytes.length,
    uploadedBy: by.user?.id ?? null,
  }
  await tx
    .insert(documentFile)
    .values({ documentId: doc.id, ...values })
    .onConflictDoUpdate({ target: documentFile.documentId, set: { ...values, createdAt: new Date() } })
  await tx
    .update(document)
    .set({
      status: 'received',
      receivedOn: theatreToday(),
      receivedVia: by.via,
      sentToFinanceAt: null,
      acceptedAt: null,
      filePurgedAt: null,
      financeNote: null,
    })
    .where(eq(document.id, doc.id))
}

const UPLOAD_LINK_CLOSED = 'This link has expired or been closed. Ask the company manager for a new one.'

/** A live upload link and what it's for, or a refusal that says nothing about why. */
async function openLink(db: Db, token: string, lock: boolean) {
  const q = db
    .select({
      link: uploadLink,
      engagementId: engagement.id,
      personId: engagement.personId,
      isDemo: engagement.isDemo,
      legalName: person.legalName,
      preferredName: person.preferredName,
      title: production.title,
    })
    .from(uploadLink)
    .innerJoin(engagement, eq(engagement.id, uploadLink.engagementId))
    .innerJoin(person, eq(person.id, engagement.personId))
    .innerJoin(production, eq(production.id, engagement.productionId))
    .where(eq(uploadLink.tokenHash, hashLinkToken(token)))
    .limit(1)
  const [row] = lock ? await q.for('update', { of: uploadLink }) : await q
  const now = Date.now()
  if (!row || row.link.revokedAt || row.link.expiresAt.getTime() <= now || row.link.uploads >= UPLOAD_LIMITS.perLink) {
    throw new TRPCError({ code: 'NOT_FOUND', message: UPLOAD_LINK_CLOSED })
  }
  const docs = await db
    .select({ documentType: document.documentType, status: document.status, financeNote: document.financeNote })
    .from(document)
    .where(and(eq(document.engagementId, row.engagementId), inArray(document.documentType, row.link.documentTypes)))
  const byType = new Map(docs.map((d) => [d.documentType, d]))
  const items = DOCUMENT_TYPES.filter((t) => row.link.documentTypes.includes(t)).map((t) => {
    const d = byType.get(t)
    const status = d?.status ?? 'missing'
    return {
      documentType: t,
      label: DOCUMENT_TYPE_LABELS[t],
      open: OPEN_FOR_UPLOAD.has(status),
      received: status !== 'missing' && status !== 'not_needed',
      // Finance's note goes back to the person so they know what to fix.
      note: status === 'received' ? (d?.financeNote ?? null) : null,
    }
  })
  if (!items.some((i) => i.open)) throw new TRPCError({ code: 'NOT_FOUND', message: UPLOAD_LINK_CLOSED })
  return { row, items }
}

/**
 * Makes an upload link for these forms. Only a hash of the token is stored;
 * the full address comes back once, to whoever asked for it.
 */
async function issueLink(
  db: Db,
  user: SessionUser,
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
      createdBy: user.id,
    })
    .returning({ id: uploadLink.id })
  await recordAudit(db, {
    actorId: user.id,
    actorEmail: user.email,
    action: 'create',
    recordType: 'upload_link',
    recordId: link!.id,
    personId: eng.personId,
    fieldGroup: 'documents',
    detail: { documentTypes: types, expiresAt: expiresAt.toISOString() },
  })
  return { id: link!.id, url: `${appOrigin()}/upload/${token}`, expiresAt }
}

function linkState(l: typeof uploadLink.$inferSelect, now = Date.now()) {
  if (l.revokedAt) return 'revoked' as const
  if (l.expiresAt.getTime() <= now) return 'expired' as const
  if (l.uploads >= UPLOAD_LIMITS.perLink) return 'used_up' as const
  return 'open' as const
}

// ---------------------------------------------------------------------------

const linksRouter = router({
  /**
   * A link the Company Manager sends so the person can upload their own forms.
   * The full address is shown once, here; only a hash of it is kept.
   */
  create: staffProcedure.input(createLinkInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['documents'])
    const eng = await engagementOrThrow(ctx.db, input.engagementId)
    const link = await issueLink(ctx.db, ctx.user, eng, input.documentTypes)
    return { id: link.id, url: link.url, expiresAt: link.expiresAt }
  }),

  revoke: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['documents'])
    const [row] = await ctx.db
      .update(uploadLink)
      .set({ revokedAt: new Date() })
      .where(eq(uploadLink.id, input.id))
      .returning({ id: uploadLink.id, engagementId: uploadLink.engagementId })
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That link no longer exists.' })
    const eng = await engagementOrThrow(ctx.db, row.engagementId)
    await recordAudit(ctx.db, {
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'update',
      recordType: 'upload_link',
      recordId: row.id,
      personId: eng.personId,
      fieldGroup: 'documents',
      detail: { revoked: true },
    })
    return { ok: true }
  }),
})

const settingsRouter = router({
  get: staffProcedure.query(async ({ ctx }) => {
    requireView(ctx.grants, 'documents')
    const settings = await loadSettings(ctx.db)
    const reqs = await ctx.db.select().from(documentRequirement)
    return {
      linkDays: settings.linkDays,
      retentionYears: settings.retentionYears,
      retentionConfirmed: settings.retentionConfirmed,
      requirements: reqs.map((r) => ({ contractType: r.contractType, documentType: r.documentType })),
    }
  }),

  save: adminProcedure.input(settingsInput).mutation(async ({ ctx, input }) => {
    await ctx.db
      .insert(documentSettings)
      .values({ id: 1, ...input })
      .onConflictDoUpdate({ target: documentSettings.id, set: input })
    await recordAudit(ctx.db, {
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'update',
      recordType: 'document_settings',
      recordId: '1',
      fieldGroup: 'documents',
      detail: { ...input },
    })
    return { ok: true }
  }),

  saveRequirements: adminProcedure.input(requirementsInput).mutation(async ({ ctx, input }) => {
    const types = DOCUMENT_TYPES.filter((t) => input.documentTypes.includes(t))
    await ctx.db.transaction(async (tx) => {
      await tx.delete(documentRequirement).where(eq(documentRequirement.contractType, input.contractType))
      if (types.length) {
        await tx
          .insert(documentRequirement)
          .values(types.map((documentType) => ({ contractType: input.contractType, documentType })))
      }
      await recordAudit(tx, {
        actorId: ctx.user.id,
        actorEmail: ctx.user.email,
        action: 'update',
        recordType: 'document_requirement',
        recordId: input.contractType,
        fieldGroup: 'documents',
        detail: { documentTypes: types },
      })
    })
    return { ok: true }
  }),
})

/** The page a person opens from an upload link. No account; the link is the key. */
export const uploadLinkRouter = router({
  get: publicProcedure.input(z.object({ token: linkToken })).query(async ({ ctx, input }) => {
    const { row, items } = await openLink(ctx.db, input.token, false)
    const firstName = row.preferredName?.trim() || row.legalName.trim().split(/\s+/)[0] || ''
    return { firstName, productionTitle: row.title, expiresAt: row.link.expiresAt, items }
  }),

  send: publicProcedure.input(linkUploadInput).mutation(async ({ ctx, input }) => {
    const file = decodeFile(input.base64)
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const { row, items } = await openLink(tx, input.token, true)
        const item = items.find((i) => i.documentType === input.documentType)
        if (!item?.open) throw new TRPCError({ code: 'BAD_REQUEST', message: "That form isn't needed on this link." })
        const eng = { id: row.engagementId, isDemo: row.isDemo }
        const doc = await lockDocument(tx, eng, input.documentType)
        if (!OPEN_FOR_UPLOAD.has(doc.status)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: "That form isn't needed on this link." })
        }
        await checkRoom(tx, doc.id)
        await storeFile(tx, doc, { ...file, fileName: input.fileName }, { user: null, via: 'upload_link' })
        await tx
          .update(uploadLink)
          .set({ uploads: row.link.uploads + 1, lastUsedAt: new Date() })
          .where(eq(uploadLink.id, row.link.id))
        await recordAudit(tx, {
          actorId: null,
          action: 'create',
          recordType: 'document_file',
          recordId: doc.id,
          personId: row.personId,
          fieldGroup: 'tax_bank',
          via: 'upload_link',
          detail: { documentType: doc.documentType, bytes: file.bytes.length, mime: file.mime, linkId: row.link.id },
        })
        await auditStatus(tx, null, doc, row.personId, { from: doc.status, to: 'received' }, 'upload_link')
        return { ok: true }
      }),
    )
  }),
})

// ---------------------------------------------------------------------------
// Reminders: an email naming the forms still needed, with a fresh upload link
// ---------------------------------------------------------------------------

type ReminderOutcome = Delivery | 'skipped' | 'failed'

interface ReminderResult {
  engagementId: string
  name: string
  outcome: ReminderOutcome
  reason?: string
  /** The email, when it didn't go out, so the Company Manager can send it herself. */
  email?: { to: string; subject: string; text: string }
}

async function remindOne(ctx: { db: Db; user: SessionUser }, engagementId: string): Promise<ReminderResult> {
  const [row] = await ctx.db
    .select({
      id: engagement.id,
      personId: engagement.personId,
      contractType: engagement.contractType,
      isDemo: engagement.isDemo,
      legalName: person.legalName,
      preferredName: person.preferredName,
      email: person.email,
      title: production.title,
    })
    .from(engagement)
    .innerJoin(person, eq(person.id, engagement.personId))
    .innerJoin(production, eq(production.id, engagement.productionId))
    .where(eq(engagement.id, engagementId))
    .limit(1)
  if (!row) return { engagementId, name: '', outcome: 'skipped', reason: 'That engagement no longer exists.' }
  const name = row.preferredName?.trim() || row.legalName
  const skip = (reason: string): ReminderResult => ({ engagementId, name, outcome: 'skipped', reason })
  const forms = formsToRemind((await loadChecklists(ctx.db, [row])).get(row.id) ?? [])
  if (!forms.length) return skip('Nothing is missing.')
  const to = row.email?.trim()
  if (!to) return skip('No email address on file.')
  const last = (await lastReminders(ctx.db, [row.id])).get(row.id)
  if (last?.delivery === 'sent' && Date.now() - last.at.getTime() < REMINDER_GAP_MS) {
    return skip('A reminder went out within the last hour.')
  }
  const theatre = (await loadOrganization(ctx.db)).name ?? ''
  try {
    return await ctx.db.transaction(async (tx) => {
      const link = await issueLink(tx, ctx.user, row, forms)
      const firstName = row.preferredName?.trim() || row.legalName.trim().split(/\s+/)[0] || ''
      const email = reminderEmail({
        firstName,
        theatre,
        productionTitle: row.title,
        forms,
        url: link.url,
        expiresAt: link.expiresAt,
        senderName: ctx.user.name,
      })
      const result = await sendEmail({ to, ...email, replyTo: ctx.user.email }, { isDemo: row.isDemo })
      if (result.delivery === 'sent') {
        // One live link per person: the one in the email they just got.
        await tx
          .update(uploadLink)
          .set({ revokedAt: new Date() })
          .where(and(eq(uploadLink.engagementId, row.id), isNull(uploadLink.revokedAt), ne(uploadLink.id, link.id)))
      }
      await recordAudit(tx, {
        actorId: ctx.user.id,
        actorEmail: ctx.user.email,
        action: 'send',
        recordType: REMINDER_RECORD,
        recordId: row.id,
        personId: row.personId,
        fieldGroup: 'documents',
        // No address and no link: just what was asked for and what happened.
        detail: { documentTypes: forms, delivery: result.delivery, linkId: link.id },
      })
      return {
        engagementId,
        name,
        outcome: result.delivery,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.delivery === 'sent' ? {} : { email: { to, ...email } }),
      }
    })
  } catch (err) {
    return { engagementId, name, outcome: 'failed', reason: err instanceof Error ? err.message : 'Sending failed.' }
  }
}

const remindersRouter = router({
  /** Whether reminders really go out here, so the screen can say so before anyone clicks. */
  status: staffProcedure.query(({ ctx }) => {
    requireView(ctx.grants, 'documents')
    return { mode: deliveryMode() }
  }),

  /** Emails each person the forms they still owe, with a fresh upload link. One or many. */
  send: staffProcedure
    .input(z.object({ engagementIds: z.array(z.uuid()).min(1).max(MAX_BULK_REMINDERS) }))
    .mutation(async ({ ctx, input }) => {
      requireEdit(ctx.grants, ['documents'])
      requireView(ctx.grants, 'contact')
      const results: ReminderResult[] = []
      for (const id of new Set(input.engagementIds)) results.push(await remindOne(ctx, id))
      return { mode: deliveryMode(), results }
    }),
})

// ---------------------------------------------------------------------------

export const documentsRouter = router({
  links: linksRouter,
  reminders: remindersRouter,
  settings: settingsRouter,

  /** Every engagement on a production with its checklist. Runs the retention backstop for staff. */
  overview: staffProcedure.input(z.object({ productionId: z.uuid() })).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'documents')
    requireView(ctx.grants, 'general')
    if (!isGuestUserId(ctx.user.id) && ctx.via !== 'connector') await purgeExpired(ctx.db)
    const [prod] = await ctx.db
      .select({ id: production.id, title: production.title, closing: production.closing })
      .from(production)
      .where(eq(production.id, input.productionId))
      .limit(1)
    if (!prod) throw new TRPCError({ code: 'NOT_FOUND', message: 'That production no longer exists.' })
    const engagements = await ctx.db
      .select({
        id: engagement.id,
        role: engagement.role,
        contractType: engagement.contractType,
        pipelineStatus: engagement.pipelineStatus,
        personId: person.id,
        legalName: person.legalName,
        preferredName: person.preferredName,
        email: person.email,
      })
      .from(engagement)
      .innerJoin(person, eq(person.id, engagement.personId))
      .where(eq(engagement.productionId, input.productionId))
      .orderBy(asc(person.legalName))
    const checklists = await loadChecklists(ctx.db, engagements)
    const settings = await loadSettings(ctx.db)
    const reminders = await lastReminders(
      ctx.db,
      engagements.map((e) => e.id),
    )
    const seesContact = sees(ctx.grants, 'contact')
    return {
      production: prod,
      retentionYears: settings.retentionYears,
      retentionConfirmed: settings.retentionConfirmed,
      engagements: engagements.map(({ email, ...e }) => {
        const checklist = checklists.get(e.id) ?? []
        return {
          ...e,
          checklist,
          summary: summarize(checklist),
          // Whether a reminder could go: forms to ask for, and somewhere to send them.
          toRemind: formsToRemind(checklist),
          hasEmail: seesContact ? Boolean(email?.trim()) : null,
          lastReminder: reminders.get(e.id) ?? null,
        }
      }),
    }
  }),

  /** Forms waiting on Finance, oldest first, across every production. */
  financeQueue: staffProcedure.query(async ({ ctx }) => {
    requireView(ctx.grants, 'documents')
    requireView(ctx.grants, 'general')
    const rows = await ctx.db
      .select({
        documentId: document.id,
        engagementId: engagement.id,
        documentType: document.documentType,
        sentToFinanceAt: document.sentToFinanceAt,
        legalName: person.legalName,
        preferredName: person.preferredName,
        productionTitle: production.title,
        hasFile: documentFile.documentId,
      })
      .from(document)
      .innerJoin(engagement, eq(engagement.id, document.engagementId))
      .innerJoin(person, eq(person.id, engagement.personId))
      .innerJoin(production, eq(production.id, engagement.productionId))
      .leftJoin(documentFile, eq(documentFile.documentId, document.id))
      .where(eq(document.status, 'sent_to_finance'))
      .orderBy(asc(document.sentToFinanceAt))
    return rows.map((r) => ({ ...r, hasFile: r.hasFile !== null }))
  }),

  /** One engagement's checklist and its upload links (never the link itself). */
  forEngagement: staffProcedure.input(z.object({ engagementId: z.uuid() })).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'documents')
    const eng = await engagementOrThrow(ctx.db, input.engagementId)
    const checklist = (await loadChecklists(ctx.db, [eng])).get(eng.id) ?? []
    const links = await ctx.db
      .select()
      .from(uploadLink)
      .where(eq(uploadLink.engagementId, eng.id))
      .orderBy(desc(uploadLink.createdAt))
      .limit(10)
    return {
      checklist,
      summary: summarize(checklist),
      links: links.map((l) => ({
        id: l.id,
        documentTypes: l.documentTypes,
        expiresAt: l.expiresAt,
        uploads: l.uploads,
        createdAt: l.createdAt,
        state: linkState(l),
      })),
      canSeeFiles: sees(ctx.grants, 'tax_bank'),
    }
  }),

  /** The Company Manager uploads a form someone handed over. */
  upload: staffProcedure.input(uploadByHandInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['documents', 'tax_bank'])
    const file = decodeFile(input.base64)
    const eng = await engagementOrThrow(ctx.db, input.engagementId)
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const doc = await lockDocument(tx, eng, input.documentType)
        if (!OPEN_FOR_UPLOAD.has(doc.status)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'That form is already with Finance or done.' })
        }
        await checkRoom(tx, doc.id)
        await storeFile(tx, doc, { ...file, fileName: input.fileName }, { user: ctx.user, via: 'company_manager' })
        await recordAudit(tx, {
          actorId: ctx.user.id,
          actorEmail: ctx.user.email,
          action: 'create',
          recordType: 'document_file',
          recordId: doc.id,
          personId: eng.personId,
          fieldGroup: 'tax_bank',
          detail: { documentType: doc.documentType, bytes: file.bytes.length, mime: file.mime },
        })
        await auditStatus(tx, ctx.user, doc, eng.personId, { from: doc.status, to: 'received' })
        return { ok: true }
      }),
    )
  }),

  /** Opens the form. Needs Tax and bank docs; every download is logged. */
  download: staffProcedure.input(documentRef).mutation(async ({ ctx, input }) => {
    requireView(ctx.grants, 'documents')
    requireView(ctx.grants, 'tax_bank')
    const eng = await engagementOrThrow(ctx.db, input.engagementId)
    const [row] = await ctx.db
      .select({ document, file: documentFile })
      .from(document)
      .leftJoin(documentFile, eq(documentFile.documentId, document.id))
      .where(and(eq(document.engagementId, eng.id), eq(document.documentType, input.documentType)))
      .limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'There is no file for that form.' })
    let out: { fileName: string; mime: string; base64: string }
    let sample = false
    if (row.file) {
      out = {
        fileName: decryptField(row.file.fileNameEnc, FILE_NAME_AAD, fieldKey()),
        mime: row.file.mime,
        base64: decryptFile(row.file.data, row.document.id).toString('base64'),
      }
    } else if (eng.isDemo && (row.document.status === 'received' || row.document.status === 'sent_to_finance')) {
      // Demo forms are statuses only; show a placeholder so the flow can be tried.
      sample = true
      const label = DOCUMENT_TYPE_LABELS[row.document.documentType]
      const bytes = await renderText(
        `SAMPLE ${label}`,
        `SAMPLE: demo placeholder\n\nThis stands in for a ${label} in the demo. The demo holds no real forms.`,
      )
      out = {
        fileName: `SAMPLE ${label}.pdf`,
        mime: 'application/pdf',
        base64: Buffer.from(bytes).toString('base64'),
      }
    } else {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'There is no file for that form.' })
    }
    await recordAudit(ctx.db, {
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'download',
      recordType: 'document_file',
      recordId: row.document.id,
      personId: eng.personId,
      fieldGroup: 'tax_bank',
      detail: { documentType: row.document.documentType, ...(sample ? { sample: true } : {}) },
    })
    return out
  }),

  /** Deletes a held file (the wrong form, say) and puts the item back to Missing. */
  removeFile: staffProcedure.input(documentRef).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['documents', 'tax_bank'])
    const eng = await engagementOrThrow(ctx.db, input.engagementId)
    return ctx.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, eng, input.documentType)
      if (doc.status !== 'received') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only a form that is in the app, not with Finance, can be removed.',
        })
      }
      await purgeFile(tx, doc.id, eng.personId, 'removed', { user: ctx.user })
      await tx
        .update(document)
        .set({ status: 'missing', receivedOn: null, receivedVia: null, financeNote: null })
        .where(eq(document.id, doc.id))
      await auditStatus(tx, ctx.user, doc, eng.personId, { from: doc.status, to: 'missing' })
      return { ok: true }
    })
  }),

  /** Hands a received form to Finance. */
  sendToFinance: staffProcedure.input(documentRef).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['documents'])
    const eng = await engagementOrThrow(ctx.db, input.engagementId)
    return ctx.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, eng, input.documentType)
      const demoSample = eng.isDemo && doc.status === 'received'
      if (doc.status !== 'received' || (!(await hasFile(tx, doc.id)) && !demoSample)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Upload the form before sending it to Finance.' })
      }
      await tx
        .update(document)
        .set({ status: 'sent_to_finance', sentToFinanceAt: new Date(), financeNote: null })
        .where(eq(document.id, doc.id))
      await recordAudit(tx, {
        actorId: ctx.user.id,
        actorEmail: ctx.user.email,
        action: 'send',
        recordType: 'document',
        recordId: doc.id,
        personId: eng.personId,
        fieldGroup: 'documents',
        detail: { documentType: doc.documentType, to: 'finance' },
      })
      return { ok: true }
    })
  }),

  /**
   * Finance has the form in QuickBooks. The app deletes its copy now and keeps
   * only the status and dates.
   */
  accept: staffProcedure.input(documentRef).mutation(async ({ ctx, input }) => {
    requireReview(ctx.grants)
    const eng = await engagementOrThrow(ctx.db, input.engagementId)
    return ctx.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, eng, input.documentType)
      if (doc.status !== 'sent_to_finance') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: "That form hasn't been sent to Finance." })
      }
      await tx
        .update(document)
        .set({ status: 'accepted', acceptedAt: new Date(), financeNote: null })
        .where(eq(document.id, doc.id))
      await auditStatus(tx, ctx.user, doc, eng.personId, { from: doc.status, to: 'accepted' })
      await purgeFile(tx, doc.id, eng.personId, 'accepted', { user: ctx.user })
      const completed = await completeIfDone(tx, ctx.user, eng.id)
      return { ok: true, paperworkComplete: completed }
    })
  }),

  /** Finance sends a form back with a note (wrong year, unsigned). The file stays for the Company Manager. */
  flag: staffProcedure.input(flagInput).mutation(async ({ ctx, input }) => {
    requireReview(ctx.grants)
    const eng = await engagementOrThrow(ctx.db, input.engagementId)
    return ctx.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, eng, input.documentType)
      if (doc.status !== 'sent_to_finance') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: "That form hasn't been sent to Finance." })
      }
      await tx
        .update(document)
        .set({ status: 'received', sentToFinanceAt: null, financeNote: input.note })
        .where(eq(document.id, doc.id))
      await auditStatus(tx, ctx.user, doc, eng.personId, { from: doc.status, to: 'received', flagged: true })
      return { ok: true }
    })
  }),

  /** This form doesn't apply this time. Deletes any file held for it. */
  markNotNeeded: staffProcedure.input(documentRef).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['documents'])
    const eng = await engagementOrThrow(ctx.db, input.engagementId)
    return ctx.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, eng, input.documentType)
      if (!OPEN_FOR_UPLOAD.has(doc.status)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That form is already with Finance or done.' })
      }
      // Deleting a held file is a file action, so it needs the same grant as Remove file.
      if (await hasFile(tx, doc.id)) requireEdit(ctx.grants, ['documents', 'tax_bank'])
      await purgeFile(tx, doc.id, eng.personId, 'not_needed', { user: ctx.user })
      await tx
        .update(document)
        .set({ status: 'not_needed', receivedOn: null, receivedVia: null, financeNote: null })
        .where(eq(document.id, doc.id))
      await auditStatus(tx, ctx.user, doc, eng.personId, { from: doc.status, to: 'not_needed' })
      const completed = await completeIfDone(tx, ctx.user, eng.id)
      return { ok: true, paperworkComplete: completed }
    })
  }),

  /** Puts a Not needed or accepted form back on the list as Missing. */
  reopen: staffProcedure.input(documentRef).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['documents'])
    const eng = await engagementOrThrow(ctx.db, input.engagementId)
    return ctx.db.transaction(async (tx) => {
      const doc = await lockDocument(tx, eng, input.documentType)
      if (doc.status !== 'not_needed' && doc.status !== 'accepted') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That form is already open.' })
      }
      await tx
        .update(document)
        .set({
          status: 'missing',
          receivedOn: null,
          receivedVia: null,
          sentToFinanceAt: null,
          acceptedAt: null,
          financeNote: null,
        })
        .where(eq(document.id, doc.id))
      await auditStatus(tx, ctx.user, doc, eng.personId, { from: doc.status, to: 'missing' })
      return { ok: true }
    })
  }),
})
