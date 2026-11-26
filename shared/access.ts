/**
 * Field-group access model, shared by the server (which enforces it) and the
 * client (which only uses it to label things). Source: the build plan's
 * "Permissions by field group" table.
 *
 * Rules:
 * - Every field belongs to exactly one field group.
 * - A role reaches a group only through an explicit grant. No grant = 'none'.
 * - Masked groups never leave the server in a list or record read. Their values
 *   come back only from a separate reveal call, which writes an audit event.
 */

export const ROLES = ['company_manager', 'finance_manager'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  company_manager: 'Company Manager',
  finance_manager: 'Finance Manager',
}

/** The role that administers the app: manages grants and reads the audit log. */
export const ADMIN_ROLE: Role = 'company_manager'

export const FIELD_GROUPS = [
  'general',
  'contact',
  'personal_id',
  'travel_id',
  'pay_terms',
  'contracts',
  'tax_bank',
  'travel_logistics',
  'housing_access',
  'comps',
] as const
export type FieldGroup = (typeof FIELD_GROUPS)[number]

export const FIELD_GROUP_LABELS: Record<FieldGroup, string> = {
  general: 'General (roster, roles, dates, conflicts)',
  contact: 'Contact (cell, email, agent)',
  personal_id: 'Personal ID (DOB, home address)',
  travel_id: 'Travel ID (TSA/KTN, frequent flyer)',
  pay_terms: 'Pay terms (pay, commission, stipend)',
  contracts: 'Contracts',
  tax_bank: 'Tax and bank docs',
  travel_logistics: 'Travel logistics (flights, cars)',
  housing_access: 'Housing access (address, door code)',
  comps: 'Comps (Phase 2)',
}

/**
 * Ordered weakest to strongest.
 * - view: read the group (masked groups: may reveal, and every reveal is logged)
 * - review: view, plus change review status (Finance on tax and bank docs)
 * - edit: create and change values
 */
export const ACCESS_LEVELS = ['none', 'view', 'review', 'edit'] as const
export type AccessLevel = (typeof ACCESS_LEVELS)[number]

export function levelAtLeast(have: AccessLevel, need: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(have) >= ACCESS_LEVELS.indexOf(need)
}

/** Values in these groups show as dots until someone with a grant taps Reveal. */
export const MASKED_GROUP_LIST = ['personal_id', 'travel_id', 'tax_bank'] as const satisfies readonly FieldGroup[]
export type MaskedGroup = (typeof MASKED_GROUP_LIST)[number]
export const MASKED_GROUPS: ReadonlySet<FieldGroup> = new Set(MASKED_GROUP_LIST)

/** Granting any level above 'none' on these needs an explicit second confirmation. */
export const CONFIRM_TO_GRANT: ReadonlySet<FieldGroup> = new Set(['travel_id', 'tax_bank'])

/** Never served over the AI connector, whatever the signed-in person's grants. */
export const NEVER_OVER_CONNECTOR: ReadonlySet<FieldGroup> = new Set([
  'personal_id',
  'travel_id',
  'tax_bank',
  'housing_access',
])

export type Grants = Partial<Record<FieldGroup, AccessLevel>>

/** The plan's Phase 1 matrix. Anything left out is 'none'. */
export const DEFAULT_GRANTS: Record<Role, Grants> = {
  company_manager: {
    general: 'edit',
    contact: 'edit',
    personal_id: 'edit',
    travel_id: 'edit',
    pay_terms: 'edit',
    contracts: 'edit',
    tax_bank: 'edit',
    travel_logistics: 'edit',
    housing_access: 'edit',
    comps: 'edit',
  },
  finance_manager: {
    general: 'view',
    contact: 'view',
    personal_id: 'view',
    pay_terms: 'view',
    contracts: 'view',
    tax_bank: 'review',
  },
}

// ---------------------------------------------------------------------------
// The public guest demo. A visitor taps "Try the demo" and is signed in as one
// shared guest account with no password. The guest isn't a staff role: it has
// no row in user_role, its grants are fixed here (the Access screen can't
// widen them), it can only read, and it never sees the masked groups.
// ---------------------------------------------------------------------------

export const GUEST_ROLE = 'guest' as const
export type ViewerRole = Role | typeof GUEST_ROLE

export const VIEWER_ROLE_LABELS: Record<ViewerRole, string> = { ...ROLE_LABELS, guest: 'Demo guest' }

/** The guest account's fixed id. Better Auth makes random ids, so no staff account can have this one. */
export const GUEST_USER_ID = 'demo-guest'
/** .invalid can never receive mail, and the account has no password to sign in with. */
export const GUEST_EMAIL = 'guest@demo.invalid'

/** How long one "Try the demo" lasts. The session isn't refreshed; tap the button again for another. */
export const GUEST_SESSION_SECONDS = 2 * 60 * 60

/**
 * What a guest can see: the roster, contacts, pay, contracts, travel and
 * housing, read-only. Never Personal ID, Travel ID or Tax and bank docs.
 */
export const GUEST_GRANTS: Grants = {
  general: 'view',
  contact: 'view',
  pay_terms: 'view',
  contracts: 'view',
  travel_logistics: 'view',
  housing_access: 'view',
  comps: 'view',
}

/** The groups a guest must never reach, whatever GUEST_GRANTS says. Checked by the tests. */
export const NEVER_FOR_GUEST: ReadonlySet<FieldGroup> = new Set(['personal_id', 'travel_id', 'tax_bank'])

export function isGuestUserId(userId: string | null | undefined): boolean {
  return userId === GUEST_USER_ID
}

export function levelFor(grants: Grants, group: FieldGroup): AccessLevel {
  return grants[group] ?? 'none'
}

// ---------------------------------------------------------------------------
// Field registry: which group each field of a record belongs to. A field that
// isn't registered is treated as unreadable, so a new column can't leak by
// being forgotten here.
// ---------------------------------------------------------------------------

export type FieldMap = Readonly<Record<string, FieldGroup | 'id'>>

export const PERSON_FIELDS = {
  id: 'id',
  legalName: 'general',
  preferredName: 'general',
  // Equity or SDC member number, printed on union contracts.
  unionMemberId: 'general',
  email: 'contact',
  cell: 'contact',
  homeAirport: 'contact',
  airportPrefs: 'contact',
  dob: 'personal_id',
  // Home address, for the union contracts. Encrypted and masked like DOB.
  homeStreet: 'personal_id',
  homeCityStateZip: 'personal_id',
  tsaKtn: 'travel_id',
  frequentFlyer: 'travel_id',
} as const satisfies FieldMap

export type PersonField = keyof typeof PERSON_FIELDS

/** Person fields in a masked group: the ones whose values only come back through Reveal. */
export type MaskedPersonField = {
  [K in PersonField]: (typeof PERSON_FIELDS)[K] extends MaskedGroup ? K : never
}[PersonField]

/** What a masked field looks like on the wire: present, but no value. */
export interface MaskedValue {
  masked: true
  hasValue: boolean
}

/**
 * What filterRecord returns: the id fields always; every other registered field
 * only if the grants allow it (so optional), as a MaskedValue for masked groups.
 * Fields missing from the registry never appear.
 */
export type FilteredRecord<T, F extends FieldMap> = {
  [K in keyof T & keyof F as F[K] extends 'id' ? K : never]: T[K]
} & {
  [K in keyof T & keyof F as F[K] extends 'id' ? never : K]?: F[K] extends MaskedGroup ? MaskedValue : T[K]
}

/**
 * Drops every field the grants don't allow and masks the masked groups.
 * Runs on the server for every record it returns, lists and searches included.
 */
export function filterRecord<T extends Record<string, unknown>, F extends FieldMap>(
  record: T,
  fields: F,
  grants: Grants,
): FilteredRecord<T, F> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    const group = fields[key]
    if (group === undefined) continue
    if (group === 'id') {
      out[key] = record[key]
      continue
    }
    if (!levelAtLeast(levelFor(grants, group), 'view')) continue
    if (MASKED_GROUPS.has(group)) {
      const value = record[key]
      const masked: MaskedValue = { masked: true, hasValue: value !== null && value !== undefined && value !== '' }
      out[key] = masked
    } else {
      out[key] = record[key]
    }
  }
  return out as FilteredRecord<T, F>
}

export function isMasked(value: unknown): value is MaskedValue {
  return typeof value === 'object' && value !== null && (value as { masked?: unknown }).masked === true
}

export type GrantChangeCheck = { ok: true } | { ok: false; reason: 'admin_role_fixed' | 'needs_confirmation' }

/**
 * Rules for changing a grant:
 * - The admin role's grants are fixed, so the Company Manager can't lock
 *   themselves out.
 * - Raising a role above 'none' on Travel ID or Tax and bank docs needs an
 *   explicit second confirmation.
 */
export function checkGrantChange(
  role: Role,
  group: FieldGroup,
  level: AccessLevel,
  confirmed: boolean,
): GrantChangeCheck {
  if (role === ADMIN_ROLE) return { ok: false, reason: 'admin_role_fixed' }
  if (CONFIRM_TO_GRANT.has(group) && level !== 'none' && !confirmed) return { ok: false, reason: 'needs_confirmation' }
  return { ok: true }
}

export const AUDIT_ACTIONS = [
  'sign_in',
  'reveal',
  'create',
  'update',
  'delete',
  'download',
  'send',
  'export',
  'grant_change',
  'role_change',
  // Claude connector: a read through a connector tool, and an app being
  // connected or disconnected.
  'read',
  'connect',
  'disconnect',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]
