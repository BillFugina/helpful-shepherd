import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { ACCESS_LEVELS, AUDIT_ACTIONS, FIELD_GROUPS, ROLES } from '../../shared/access.js'

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}

// ---------------------------------------------------------------------------
// Better Auth tables. Field names follow Better Auth's core schema plus the
// two-factor plugin's additions; the drizzle adapter maps them by property name.
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  ...timestamps,
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    ...timestamps,
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

export const twoFactor = pgTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (t) => [index('two_factor_user_id_idx').on(t.userId), index('two_factor_secret_idx').on(t.secret)],
)

/** Better Auth's rate limiter, kept in the database so limits hold across serverless instances. */
export const rateLimit = pgTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
})

// ---------------------------------------------------------------------------
// Access control. Every field belongs to a field group; a role sees a group
// only through an explicit grant row. No row means no access (default deny).
// ---------------------------------------------------------------------------

export const staffRole = pgEnum('staff_role', ROLES)
export const fieldGroup = pgEnum('field_group', FIELD_GROUPS)
export const accessLevel = pgEnum('access_level', ACCESS_LEVELS)
export const auditAction = pgEnum('audit_action', AUDIT_ACTIONS)

/** One role per staff user. A user with no row here can sign in but sees nothing. */
export const userRole = pgTable('user_role', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: staffRole('role').notNull(),
  ...timestamps,
})

export const roleGrant = pgTable(
  'role_grant',
  {
    role: staffRole('role').notNull(),
    fieldGroup: fieldGroup('field_group').notNull(),
    level: accessLevel('level').notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.role, t.fieldGroup] })],
)

/**
 * Append-only: a database trigger (see the migration) rejects UPDATE and DELETE,
 * so even a bug or a stray query in the app can't rewrite history.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    // Not a foreign key: the log must outlive a deleted user.
    actorId: text('actor_id'),
    actorEmail: text('actor_email'),
    action: auditAction('action').notNull(),
    // Which record, e.g. ('person', '<uuid>'), and which field group, when it applies.
    recordType: text('record_type'),
    recordId: text('record_id'),
    // The person the record is about, so the log can be filtered by person.
    personId: uuid('person_id'),
    fieldGroup: fieldGroup('field_group'),
    // 'app' for the web app; 'connector' later for the AI connector.
    via: text('via').notNull().default('app'),
    // Field names or other context. Never values: the log holds no sensitive data.
    detail: jsonb('detail').$type<Record<string, unknown>>(),
  },
  (t) => [index('audit_event_at_idx').on(t.at), index('audit_event_person_id_idx').on(t.personId, t.at)],
)

// ---------------------------------------------------------------------------
// People. Just the person record for now, so the permission filter, field
// encryption, Reveal and the audit log work end to end. Seasons, productions,
// agents and engagements come with the roster slice.
// ---------------------------------------------------------------------------

export const person = pgTable(
  'person',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // General
    legalName: text('legal_name').notNull(),
    preferredName: text('preferred_name'),
    // Contact
    email: text('email'),
    cell: text('cell'),
    homeAirport: text('home_airport'),
    // Personal ID: encrypted in the app before it reaches the database.
    dobEnc: text('dob_enc'),
    // Travel ID: encrypted in the app before it reaches the database.
    tsaKtnEnc: text('tsa_ktn_enc'),
    frequentFlyerEnc: text('frequent_flyer_enc'),
    // Marks seeded demo rows, so a reseed can replace them and nothing else.
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => [index('person_legal_name_idx').on(sql`lower(${t.legalName})`)],
)
