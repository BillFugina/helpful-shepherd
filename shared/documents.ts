/**
 * Documents: the paperwork checklist for each engagement and the handoff to
 * Finance. Shared by the server (which enforces it) and the client (labels,
 * input schemas, the checklist rules). Source: Ash's PRD (Nov 24, 2026),
 * section 4, and the build plan's "handoff mode".
 *
 * Handoff mode: a form comes in (by upload link, or uploaded by the Company
 * Manager), is encrypted before it reaches the database, goes to Finance in
 * one click, and is deleted the moment Finance accepts it, because QuickBooks
 * is the record. The app keeps only the status and dates. A backstop deletes
 * any file still held a set time after the production closes.
 *
 * Two field groups:
 * - documents: the checklist itself (which forms, their statuses, dates and
 *   Finance's note). No numbers, no files. The guest demo and the Claude
 *   connector can see it.
 * - tax_bank: the files. Downloading one needs it, and is logged. Never for the
 *   guest, never over the connector.
 */
import { z } from 'zod'
import type { FieldMap } from './access.js'
import { CONTRACT_TYPES, type ContractType } from './roster.js'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** The forms on the PRD's list. Contracts are tracked on the Contracts pages. */
export const DOCUMENT_TYPES = [
  'w4',
  'nc4',
  'i9',
  'w9',
  'equity_deferral',
  'direct_deposit',
  'bank_verification',
] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  w4: 'W-4',
  nc4: 'NC-4 withholding',
  i9: 'I-9',
  w9: 'W-9',
  equity_deferral: 'Equity deferral form',
  direct_deposit: 'Direct deposit authorization',
  bank_verification: 'Bank verification (voided check)',
}

/**
 * The PRD's four statuses, plus Not needed for a form that doesn't apply this
 * time (say, an I-9 that's still on file from last season).
 */
export const DOCUMENT_STATUSES = ['missing', 'received', 'sent_to_finance', 'accepted', 'not_needed'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  missing: 'Missing',
  received: 'Received',
  sent_to_finance: 'Sent to Finance',
  accepted: 'Accepted by Finance',
  not_needed: 'Not needed',
}

/** Done: nothing more to collect or hand off. */
export const DONE_STATUSES: ReadonlySet<DocumentStatus> = new Set(['accepted', 'not_needed'])
/** Still needs something from the person: the upload link takes these. */
export const OPEN_FOR_UPLOAD: ReadonlySet<DocumentStatus> = new Set(['missing', 'received'])

/**
 * Starting checklist for each contract type. Equity ITC actors and non-union
 * company members are employees (W-4, NC-4, I-9); SDC directors and
 * choreographers are usually contractors (W-9). The Company Manager changes
 * these on the Documents settings screen.
 */
export const DEFAULT_REQUIREMENTS: Record<ContractType, readonly DocumentType[]> = {
  equity_itc: ['w4', 'nc4', 'i9', 'equity_deferral', 'direct_deposit', 'bank_verification'],
  sdc: ['w9', 'direct_deposit', 'bank_verification'],
  non_union: ['w4', 'nc4', 'i9', 'direct_deposit', 'bank_verification'],
}

// ---------------------------------------------------------------------------
// Field registry
// ---------------------------------------------------------------------------

export const DOCUMENT_FIELDS = {
  id: 'id',
  engagementId: 'id',
  documentType: 'documents',
  status: 'documents',
  required: 'documents',
  hasFile: 'documents',
  receivedOn: 'documents',
  receivedVia: 'documents',
  sentToFinanceAt: 'documents',
  acceptedAt: 'documents',
  filePurgedAt: 'documents',
  financeNote: 'documents',
} as const satisfies FieldMap

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Uploads go through a Vercel function, which takes a 4.5 MB request; base64
 * adds a third, so 3 MB of file is the most that fits. Plenty for a PDF or a
 * phone photo of a form.
 */
export const MAX_FILE_BYTES = 3 * 1024 * 1024
export const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4

export const FILE_KINDS = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG photo',
  'image/png': 'PNG image',
} as const
export type FileMime = keyof typeof FILE_KINDS
export const ACCEPT_ATTRIBUTE = 'application/pdf,image/jpeg,image/png'

/** What the bytes actually are, from their first few bytes. Never trusts the name or the browser's label. */
export function sniffMime(bytes: Uint8Array): FileMime | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b)
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf' // %PDF-
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  return null
}

/** Upload limits that keep a free tier safe. */
export const UPLOAD_LIMITS = {
  /** Uploads one link takes before it closes, replacements included. */
  perLink: 20,
  /** Files held at once across the whole app. */
  filesHeld: 300,
} as const

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

export interface DocumentRow {
  id: string
  documentType: DocumentType
  status: DocumentStatus
  hasFile: boolean
  receivedOn: string | null
  receivedVia: string | null
  sentToFinanceAt: Date | null
  acceptedAt: Date | null
  filePurgedAt: Date | null
  financeNote: string | null
}

export interface ChecklistItem extends Omit<DocumentRow, 'id'> {
  /** Null until something has happened to this form. */
  id: string | null
  /** On the list for this contract type. A form off the list shows only if it has a record. */
  required: boolean
}

/**
 * One engagement's checklist: every form its contract type requires (Missing
 * until something happens) and any other form that has a record, in the
 * standard order. Built on read, so changing the requirements or the contract
 * type changes the checklist straight away.
 */
export function buildChecklist(required: readonly DocumentType[], rows: readonly DocumentRow[]): ChecklistItem[] {
  const byType = new Map(rows.map((r) => [r.documentType, r]))
  const need = new Set(required)
  const items: ChecklistItem[] = []
  for (const type of DOCUMENT_TYPES) {
    const row = byType.get(type)
    if (row) items.push({ ...row, required: need.has(type) })
    else if (need.has(type)) {
      items.push({
        id: null,
        documentType: type,
        status: 'missing',
        required: true,
        hasFile: false,
        receivedOn: null,
        receivedVia: null,
        sentToFinanceAt: null,
        acceptedAt: null,
        filePurgedAt: null,
        financeNote: null,
      })
    }
  }
  return items
}

export interface ChecklistSummary {
  total: number
  missing: number
  /** In the app, waiting for the Company Manager to send to Finance. */
  received: number
  /** With Finance, waiting for them to accept. */
  withFinance: number
  done: number
  /** Finance sent it back with a note. */
  flagged: number
  complete: boolean
}

/** Counts for the required forms only: a form off the list never holds anyone up. */
export function summarize(items: readonly ChecklistItem[]): ChecklistSummary {
  const req = items.filter((i) => i.required)
  const count = (s: DocumentStatus) => req.filter((i) => i.status === s).length
  const done = req.filter((i) => DONE_STATUSES.has(i.status)).length
  return {
    total: req.length,
    missing: count('missing'),
    received: count('received'),
    withFinance: count('sent_to_finance'),
    done,
    flagged: req.filter((i) => i.status === 'received' && i.financeNote).length,
    complete: done === req.length,
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  /** Days an upload link works. */
  linkDays: 14,
  /**
   * Years after a production closes before the backstop deletes any form
   * still held. Ash's guess was 2 to 5 years; Finance hasn't confirmed.
   */
  retentionYears: 3,
} as const

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const documentType = z.enum(DOCUMENT_TYPES)

export const documentRef = z.object({ engagementId: z.uuid(), documentType })

export const uploadByHandInput = documentRef.extend({
  fileName: z.string().trim().min(1).max(200),
  base64: z.string().min(8).max(MAX_BASE64_CHARS),
})

export const financeNoteText = z.string().trim().min(1).max(500)
export const flagInput = documentRef.extend({ note: financeNoteText })

export const createLinkInput = z.object({
  engagementId: z.uuid(),
  documentTypes: z.array(documentType).min(1).max(DOCUMENT_TYPES.length),
})

export const settingsInput = z.object({
  linkDays: z.number().int().min(1).max(60),
  retentionYears: z.number().int().min(1).max(10),
  retentionConfirmed: z.boolean(),
})

export const requirementsInput = z.object({
  contractType: z.enum(CONTRACT_TYPES),
  documentTypes: z.array(documentType).max(DOCUMENT_TYPES.length),
})

/** Upload link tokens: 32 random bytes, base64url (43 characters). */
export const linkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'That link is not right.')

export const linkUploadInput = z.object({
  token: linkToken,
  documentType,
  fileName: z.string().trim().min(1).max(200),
  base64: z.string().min(8).max(MAX_BASE64_CHARS),
})
