import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { ACCESS_LEVELS, AUDIT_ACTIONS, FIELD_GROUPS, ROLES } from '../../shared/access.js'
import { CONTRACT_TYPES, PIPELINE_STATUSES, PROGRAMS } from '../../shared/roster.js'

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
    // The moment of the insert, not the start of its transaction, so events
    // written inside a serialized transaction sort in the order they happened.
    at: timestamp('at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
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
// People. A person is reused every season; their deal for one production is
// an engagement (below).
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
    airportPrefs: text('airport_prefs'),
    // Personal ID: encrypted in the app before it reaches the database.
    dobEnc: text('dob_enc'),
    // Travel ID: encrypted in the app before it reaches the database.
    tsaKtnEnc: text('tsa_ktn_enc'),
    frequentFlyerEnc: text('frequent_flyer_enc'),
    // Marks seeded demo rows, so a reseed can replace them and nothing else.
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('person_legal_name_idx').on(sql`lower(${t.legalName})`),
    index('person_email_idx').on(sql`lower(${t.email})`),
  ],
)

// ---------------------------------------------------------------------------
// Roster. Field groups for every column are in shared/roster.ts.
// ---------------------------------------------------------------------------

export const program = pgEnum('program', PROGRAMS)
export const contractType = pgEnum('contract_type', CONTRACT_TYPES)
export const pipelineStatus = pgEnum('pipeline_status', PIPELINE_STATUSES)

export const season = pgTable(
  'season',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    program: program('program').notNull().default('main_stage'),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => [check('season_dates_in_order', sql`${t.startsOn} <= ${t.endsOn}`)],
)

export const production = pgTable(
  'production',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Restrict: a season with productions can't vanish and take them along.
    seasonId: uuid('season_id')
      .notNull()
      .references(() => season.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    rehearsalStart: date('rehearsal_start', { mode: 'string' }),
    techStart: date('tech_start', { mode: 'string' }),
    opening: date('opening', { mode: 'string' }),
    closing: date('closing', { mode: 'string' }),
    performanceSchedule: text('performance_schedule'),
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('production_season_id_idx').on(t.seasonId),
    // Each date that's set comes on or after the ones before it.
    check(
      'production_rehearsal_before_tech',
      sql`${t.rehearsalStart} is null or ${t.techStart} is null or ${t.rehearsalStart} <= ${t.techStart}`,
    ),
    check(
      'production_tech_before_opening',
      sql`${t.techStart} is null or ${t.opening} is null or ${t.techStart} <= ${t.opening}`,
    ),
    check(
      'production_rehearsal_before_opening',
      sql`${t.rehearsalStart} is null or ${t.opening} is null or ${t.rehearsalStart} <= ${t.opening}`,
    ),
    check(
      'production_opening_before_closing',
      sql`${t.opening} is null or ${t.closing} is null or ${t.opening} <= ${t.closing}`,
    ),
    check(
      'production_rehearsal_before_closing',
      sql`${t.rehearsalStart} is null or ${t.closing} is null or ${t.rehearsalStart} <= ${t.closing}`,
    ),
    check(
      'production_tech_before_closing',
      sql`${t.techStart} is null or ${t.closing} is null or ${t.techStart} <= ${t.closing}`,
    ),
  ],
)

export const agent = pgTable(
  'agent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    agency: text('agency'),
    email: text('email'),
    phone: text('phone'),
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => [index('agent_name_idx').on(sql`lower(${t.name})`)],
)

/** One person's deal for one production. Everything operational hangs off this. */
export const engagement = pgTable(
  'engagement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'restrict' }),
    productionId: uuid('production_id')
      .notNull()
      .references(() => production.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id').references(() => agent.id, { onDelete: 'set null' }),
    role: text('role').notNull(),
    contractType: contractType('contract_type').notNull(),
    pipelineStatus: pipelineStatus('pipeline_status').notNull().default('offer_accepted'),
    // Pay terms. Money in whole cents; a null commission means none.
    weeklyPayCents: integer('weekly_pay_cents'),
    commissionPercent: numeric('commission_percent', { precision: 5, scale: 2, mode: 'number' }),
    weeklyStipendCents: integer('weekly_stipend_cents'),
    travelProvided: boolean('travel_provided').notNull().default(false),
    carProvided: boolean('car_provided').notNull().default(false),
    housingProvided: boolean('housing_provided').notNull().default(false),
    preferredArrival: date('preferred_arrival', { mode: 'string' }),
    preferredDeparture: date('preferred_departure', { mode: 'string' }),
    scriptNeeded: boolean('script_needed').notNull().default(false),
    compAllotment: integer('comp_allotment').notNull().default(2),
    notes: text('notes'),
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    // One deal per person per production.
    unique('engagement_person_production_uq').on(t.personId, t.productionId),
    index('engagement_production_id_idx').on(t.productionId),
    index('engagement_agent_id_idx').on(t.agentId),
    check(
      'engagement_money_not_negative',
      sql`coalesce(${t.weeklyPayCents}, 0) >= 0 and coalesce(${t.weeklyStipendCents}, 0) >= 0`,
    ),
    check(
      'engagement_commission_range',
      sql`${t.commissionPercent} is null or ${t.commissionPercent} between 0 and 100`,
    ),
    check('engagement_comps_not_negative', sql`${t.compAllotment} >= 0`),
    check(
      'engagement_travel_dates_in_order',
      sql`${t.preferredArrival} is null or ${t.preferredDeparture} is null or ${t.preferredArrival} <= ${t.preferredDeparture}`,
    ),
  ],
)

export const conflict = pgTable(
  'conflict',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagement.id, { onDelete: 'cascade' }),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    description: text('description').notNull(),
    ...timestamps,
  },
  (t) => [
    index('conflict_engagement_id_idx').on(t.engagementId),
    check('conflict_dates_in_order', sql`${t.startsOn} <= ${t.endsOn}`),
  ],
)
