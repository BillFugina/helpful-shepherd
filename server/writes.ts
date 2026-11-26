import { TRPCError } from '@trpc/server'
import {
  FIELD_GROUP_LABELS,
  levelAtLeast,
  levelFor,
  type AuditAction,
  type FieldGroup,
  type FieldMap,
  type Grants,
} from '../shared/access.js'
import { recordAudit } from './audit.js'
import type { Db } from './db/client.js'
import type { SessionUser } from './trpc.js'

/** Keys of an input object that carry a value to write (undefined means "leave as is"). */
export function writtenKeys(input: Record<string, unknown>, fields: FieldMap): string[] {
  return Object.keys(input).filter((k) => input[k] !== undefined && fields[k] !== undefined && fields[k] !== 'id')
}

/** The field groups touched by these keys, in registry order. */
export function groupsOf(keys: readonly string[], fields: FieldMap): FieldGroup[] {
  const groups = new Set<FieldGroup>()
  for (const k of keys) {
    const g = fields[k]
    if (g && g !== 'id') groups.add(g)
  }
  return [...groups]
}

/**
 * Writing a field needs 'edit' on its group. Checked before anything is
 * written, so a form that mixes groups either saves whole or not at all.
 */
export function requireEdit(grants: Grants, groups: readonly FieldGroup[]): void {
  const missing = groups.filter((g) => !levelAtLeast(levelFor(grants, g), 'edit'))
  if (missing.length) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Your role can't change ${missing.map((g) => FIELD_GROUP_LABELS[g]).join(', ')}.`,
    })
  }
}

/** Reading needs at least 'view' on the group. */
export function requireView(grants: Grants, group: FieldGroup): void {
  if (!levelAtLeast(levelFor(grants, group), 'view')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `Your role has no access to ${FIELD_GROUP_LABELS[group]}.` })
  }
}

export interface ChangeAudit {
  action: Extract<AuditAction, 'create' | 'update' | 'delete'>
  recordType: string
  recordId: string
  personId?: string
  /** Field names written. Names only: the log never holds values. */
  keys: readonly string[]
  fields: FieldMap
  detail?: Record<string, unknown>
}

/**
 * One audit event per field group touched, so the log can be filtered by
 * group the same way access is granted. A record with no group fields written
 * (a bare delete) still gets one event.
 */
export async function auditChange(db: Db, user: SessionUser, change: ChangeAudit): Promise<void> {
  const groups = groupsOf(change.keys, change.fields)
  const base = {
    actorId: user.id,
    actorEmail: user.email,
    action: change.action,
    recordType: change.recordType,
    recordId: change.recordId,
    personId: change.personId,
  }
  if (!groups.length) {
    await recordAudit(db, { ...base, detail: change.detail })
    return
  }
  for (const group of groups) {
    const fields = change.keys.filter((k) => change.fields[k] === group)
    await recordAudit(db, { ...base, fieldGroup: group, detail: { ...change.detail, fields } })
  }
}

interface PgError {
  code?: string
  constraint?: string
}

function pgCause(error: unknown): PgError | null {
  let e: unknown = error
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const code = (e as PgError).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return e as PgError
    e = (e as { cause?: unknown }).cause
  }
  return null
}

const CONSTRAINT_MESSAGES: Record<string, string> = {
  engagement_person_production_uq: 'This person is already on that production.',
  housing_room_unit_name_uq: 'That place already has a room with this name.',
  housing_preference_person_rule_uq: 'This person already has that housing rule.',
  housing_assignment_room_id_housing_room_id_fk: 'Someone is assigned to this room. Move them first.',
  housing_assignment_room_no_overlap: 'Someone else has that room for some of those nights.',
  housing_assignment_engagement_no_overlap: 'This person already has a room for some of those nights.',
  contract_engagement_family_live_uq: 'This engagement already has that contract. Void it first to start over.',
  contract_template_template_id_contract_template_id_fk: 'Contracts were made from this template. Retire it instead.',
  flight_departs_before_arriving: 'The flight has to land after it takes off. Check both times and time zones.',
}

/**
 * Turns database constraint errors into answers a person can act on. The
 * database is the last line of defense for these rules; the input schemas
 * catch most of them first.
 */
export function asUserError(error: unknown): unknown {
  if (error instanceof TRPCError) return error
  const pg = pgCause(error)
  if (!pg) return error
  const known = pg.constraint ? CONSTRAINT_MESSAGES[pg.constraint] : undefined
  switch (pg.code) {
    case '23505':
      return new TRPCError({ code: 'CONFLICT', message: known ?? 'That already exists.', cause: error })
    case '23514':
      return new TRPCError({
        code: 'BAD_REQUEST',
        message: known ?? 'Those dates or amounts are out of order or out of range.',
        cause: error,
      })
    case '23P01':
      return new TRPCError({
        code: 'CONFLICT',
        message: known ?? 'That overlaps something already booked.',
        cause: error,
      })
    case '23503':
      return new TRPCError({
        code: 'BAD_REQUEST',
        message: known ?? 'That refers to a record that no longer exists, or one that other records still use.',
        cause: error,
      })
    default:
      return error
  }
}

/** Runs a write and reports constraint errors in plain words. */
export async function friendly<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw asUserError(error)
  }
}
