import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { ACCESS_LEVELS, AUDIT_ACTIONS, FIELD_GROUPS, ROLES } from '../../shared/access.js'
import { CONTRACT_STATUSES, TEMPLATE_FORMATS } from '../../shared/contracts.js'
import { DOCUMENT_STATUSES, DOCUMENT_TYPES } from '../../shared/documents.js'
import { DRAFT_STATUS_LIST } from '../../shared/drafts.js'
import { CONTRACT_TYPES, PIPELINE_STATUSES, PROGRAMS } from '../../shared/roster.js'
import {
  FLIGHT_DIRECTIONS,
  FLIGHT_EVENT_KINDS,
  HOUSING_KINDS,
  HOUSING_RULES,
  LIVE_STATUSES,
} from '../../shared/travel.js'

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
// Claude connector: Better Auth's JWT plugin (signing keys) and OAuth provider
// tables. Ash's Claude signs in through these with her app login and 2FA.
// Field names follow the plugins' schemas; the drizzle adapter maps them by
// property name.
// ---------------------------------------------------------------------------

/** Key pairs that sign the connector's access tokens. Private keys are encrypted by Better Auth. */
export const jwks = pgTable('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  alg: text('alg'),
  crv: text('crv'),
})

/** An app that asked to connect, such as Ash's Claude. Registered by the app itself (dynamic registration). */
export const oauthClient = pgTable(
  'oauth_client',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: boolean('disabled').default(false),
    skipConsent: boolean('skip_consent'),
    enableEndSession: boolean('enable_end_session'),
    subjectType: text('subject_type'),
    scopes: text('scopes').array(),
    clientCredentialsScopes: text('client_credentials_scopes').array(),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts').array(),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    jwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types').array(),
    responseTypes: text('response_types').array(),
    requirePKCE: boolean('require_pkce'),
    dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata'),
  },
  (t) => [index('oauth_client_user_id_idx').on(t.userId)],
)

/** The protected resource tokens are issued for: the connector's MCP endpoint. */
export const oauthResource = pgTable('oauth_resource', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean('disabled').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  policyVersion: integer('policy_version'),
  metadata: jsonb('metadata'),
})

export const oauthClientResource = pgTable(
  'oauth_client_resource',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }),
  },
  (t) => [
    index('oauth_client_resource_client_id_idx').on(t.clientId),
    index('oauth_client_resource_resource_id_idx').on(t.resourceId),
  ],
)

export const oauthRefreshToken = pgTable(
  'oauth_refresh_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revoked: timestamp('revoked', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: timestamp('rotation_replay_expires_at', { withTimezone: true }),
    authTime: timestamp('auth_time', { withTimezone: true }),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => [
    index('oauth_refresh_token_client_id_idx').on(t.clientId),
    index('oauth_refresh_token_session_id_idx').on(t.sessionId),
    index('oauth_refresh_token_user_id_idx').on(t.userId),
    index('oauth_refresh_token_authorization_code_id_idx').on(t.authorizationCodeId),
  ],
)

export const oauthAccessToken = pgTable(
  'oauth_access_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    refreshId: text('refresh_id').references(() => oauthRefreshToken.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revoked: timestamp('revoked', { withTimezone: true }),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => [
    index('oauth_access_token_client_id_idx').on(t.clientId),
    index('oauth_access_token_session_id_idx').on(t.sessionId),
    index('oauth_access_token_user_id_idx').on(t.userId),
    index('oauth_access_token_authorization_code_id_idx').on(t.authorizationCodeId),
    index('oauth_access_token_refresh_id_idx').on(t.refreshId),
  ],
)

/** A person's yes to an app. Deleting it (Disconnect in the app) cuts the app off at once. */
export const oauthConsent = pgTable(
  'oauth_consent',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    scopes: text('scopes').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('oauth_consent_client_id_idx').on(t.clientId), index('oauth_consent_user_id_idx').on(t.userId)],
)

export const oauthClientAssertion = pgTable('oauth_client_assertion', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
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
    unionMemberId: text('union_member_id'),
    // Contact
    email: text('email'),
    cell: text('cell'),
    homeAirport: text('home_airport'),
    airportPrefs: text('airport_prefs'),
    // Personal ID: encrypted in the app before it reaches the database.
    dobEnc: text('dob_enc'),
    homeStreetEnc: text('home_street_enc'),
    homeCityStateZipEnc: text('home_city_state_zip_enc'),
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
    venueName: text('venue_name'),
    venueCapacity: integer('venue_capacity'),
    topTicketCents: integer('top_ticket_cents'),
    scheduledPerformances: integer('scheduled_performances'),
    rehearsalLocation: text('rehearsal_location'),
    rehearsalCallTime: text('rehearsal_call_time'),
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('production_season_id_idx').on(t.seasonId),
    check(
      'production_venue_numbers_positive',
      sql`coalesce(${t.venueCapacity}, 1) > 0 and coalesce(${t.topTicketCents}, 0) >= 0 and coalesce(${t.scheduledPerformances}, 1) > 0`,
    ),
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
    feeCents: integer('fee_cents'),
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
      sql`coalesce(${t.weeklyPayCents}, 0) >= 0 and coalesce(${t.weeklyStipendCents}, 0) >= 0 and coalesce(${t.feeCents}, 0) >= 0`,
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

export const draftStatus = pgEnum('draft_status', DRAFT_STATUS_LIST)

/**
 * A new person and engagement proposed by the Claude connector from a pasted
 * acceptance email. Nothing is committed until the Company Manager reviews it
 * in the app and saves it through the normal fast entry form.
 */
export const engagementDraft = pgTable(
  'engagement_draft',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productionId: uuid('production_id')
      .notNull()
      .references(() => production.id, { onDelete: 'cascade' }),
    status: draftStatus('status').notNull().default('pending'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdVia: text('created_via').notNull().default('connector'),
    // The pasted email, kept only until the draft is accepted or dismissed.
    sourceText: text('source_text'),
    // What the connector proposed: person, agent, terms and conflicts. Same
    // shape as the fast entry form; validated on the way in.
    proposal: jsonb('proposal').$type<Record<string, unknown>>().notNull(),
    // Returning people and agents the connector matched by email or name.
    matchedPersonId: uuid('matched_person_id').references(() => person.id, { onDelete: 'set null' }),
    matchedAgentId: uuid('matched_agent_id').references(() => agent.id, { onDelete: 'set null' }),
    // The engagement saved from this draft, once accepted.
    engagementId: uuid('engagement_id').references(() => engagement.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('engagement_draft_status_idx').on(t.status, t.createdAt)],
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

// ---------------------------------------------------------------------------
// Arrivals: flights, rental cars and housing. Field groups for every column
// are in shared/travel.ts.
// ---------------------------------------------------------------------------

export const flightDirection = pgEnum('flight_direction', FLIGHT_DIRECTIONS)
export const liveStatus = pgEnum('flight_live_status', LIVE_STATUSES)
export const flightEventKind = pgEnum('flight_event_kind', FLIGHT_EVENT_KINDS)
export const housingKind = pgEnum('housing_kind', HOUSING_KINDS)
export const housingRule = pgEnum('housing_rule', HOUSING_RULES)

/**
 * One leg of someone's travel. Scheduled times are what was booked; the live_*
 * columns are written only by the flight tracker, so a delay never overwrites
 * the booking.
 */
export const flight = pgTable(
  'flight',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagement.id, { onDelete: 'cascade' }),
    direction: flightDirection('direction').notNull(),
    airline: text('airline').notNull(),
    flightNumber: text('flight_number').notNull(),
    fromAirport: text('from_airport').notNull(),
    toAirport: text('to_airport').notNull(),
    scheduledDeparture: timestamp('scheduled_departure', { withTimezone: true }).notNull(),
    scheduledArrival: timestamp('scheduled_arrival', { withTimezone: true }).notNull(),
    confirmation: text('confirmation'),
    bookingSource: text('booking_source'),
    notes: text('notes'),
    liveStatus: liveStatus('live_status'),
    liveDeparture: timestamp('live_departure', { withTimezone: true }),
    liveArrival: timestamp('live_arrival', { withTimezone: true }),
    liveGate: text('live_gate'),
    liveTerminal: text('live_terminal'),
    liveBaggage: text('live_baggage'),
    liveCheckedAt: timestamp('live_checked_at', { withTimezone: true }),
    /** The AeroDataBox push subscription watching this flight now, if any. Shared by flights with the same number. */
    pushSubscriptionId: uuid('push_subscription_id').references(() => flightSubscription.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    index('flight_engagement_id_idx').on(t.engagementId),
    index('flight_scheduled_arrival_idx').on(t.scheduledArrival),
    index('flight_scheduled_departure_idx').on(t.scheduledDeparture),
    check('flight_departs_before_arriving', sql`${t.scheduledDeparture} < ${t.scheduledArrival}`),
  ],
)

/**
 * A push subscription at AeroDataBox, keyed by flight number. Booked flights
 * share one while they're in the air ('flight'); a Company Manager can also
 * watch any real flight for a while to see pushes arrive ('test'). The
 * callback URL carries a random token; only its hash is kept here.
 */
export const flightSubscription = pgTable(
  'flight_subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** AeroDataBox's subscription id. Null until the subscribe call returns. */
    providerId: text('provider_id'),
    /** Airline code and number with no spaces, upper case: "B61017". */
    flightNumber: text('flight_number').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** 'flight' or 'test'. */
    purpose: text('purpose').notNull(),
    /** The staff user who started a test. */
    startedBy: text('started_by'),
    active: boolean('active').notNull().default(true),
    creditsRemaining: integer('credits_remaining'),
    lastPushAt: timestamp('last_push_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('flight_subscription_token_hash_uq').on(t.tokenHash),
    // One live shared subscription per flight number, so two flights can't both create one.
    uniqueIndex('flight_subscription_flight_live_uq')
      .on(t.flightNumber)
      .where(sql`${t.active} and ${t.purpose} = 'flight'`),
  ],
)

/** One flight item from a push, kept so the live test can show what arrived. Flight data only. */
export const flightPush = pgTable(
  'flight_push',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => flightSubscription.id, { onDelete: 'cascade' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    number: text('number').notNull(),
    status: text('status').notNull(),
    fromAirport: text('from_airport'),
    toAirport: text('to_airport'),
    scheduledDeparture: timestamp('scheduled_departure', { withTimezone: true }),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
  },
  (t) => [index('flight_push_subscription_id_idx').on(t.subscriptionId, t.receivedAt)],
)

/** What the tracker noticed changing on a flight, for the board's alerts. */
export const flightEvent = pgTable(
  'flight_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flightId: uuid('flight_id')
      .notNull()
      .references(() => flight.id, { onDelete: 'cascade' }),
    /** The feed's time when the change was seen (the demo clock, when it's moved). */
    at: timestamp('at', { withTimezone: true }).notNull(),
    kind: flightEventKind('kind').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    /** When the scheduled job took this change for an email alert. Null until then. */
    alertedAt: timestamp('alerted_at', { withTimezone: true }),
  },
  (t) => [index('flight_event_flight_id_idx').on(t.flightId, t.at)],
)

/**
 * One device that turned on phone alerts (Web Push). The endpoint and keys
 * come from the browser; they let the push service reach that one device and
 * nothing else. Removed when the push service says it's gone, or on sign-out.
 */
export const pushSubscription = pgTable(
  'push_subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** "iPhone", "Android phone", "Mac": worked out by the browser, for the device list. */
    deviceLabel: text('device_label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last time a push to this device was accepted. */
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    /** Failed sends in a row, other than "gone". Reset by a good send. */
    failures: integer('failures').notNull().default(0),
  },
  (t) => [index('push_subscription_user_id_idx').on(t.userId)],
)

export const rentalCar = pgTable(
  'rental_car',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagement.id, { onDelete: 'cascade' }),
    company: text('company').notNull(),
    confirmation: text('confirmation'),
    pickupAt: timestamp('pickup_at', { withTimezone: true }).notNull(),
    pickupPlace: text('pickup_place'),
    returnAt: timestamp('return_at', { withTimezone: true }).notNull(),
    returnPlace: text('return_place'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    index('rental_car_engagement_id_idx').on(t.engagementId),
    check('rental_car_pickup_before_return', sql`${t.pickupAt} < ${t.returnAt}`),
  ],
)

export const housingUnit = pgTable('housing_unit', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: housingKind('kind').notNull(),
  address: text('address'),
  accessNotes: text('access_notes'),
  doorCode: text('door_code'),
  notes: text('notes'),
  isDemo: boolean('is_demo').notNull().default(false),
  ...timestamps,
})

/** Assignments point at a room, and each room names its bathroom, so "won't share a bathroom" can be checked. */
export const housingRoom = pgTable(
  'housing_room',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => housingUnit.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    floor: integer('floor').notNull().default(1),
    bathroom: text('bathroom').notNull(),
    ...timestamps,
  },
  (t) => [index('housing_room_unit_id_idx').on(t.unitId), unique('housing_room_unit_name_uq').on(t.unitId, t.name)],
)

/** One person in one room from move-in night to move-out day. The app refuses two stays in a room on the same night. */
export const housingAssignment = pgTable(
  'housing_assignment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagement.id, { onDelete: 'cascade' }),
    // Restrict: a room with people in it can't be deleted out from under them.
    roomId: uuid('room_id')
      .notNull()
      .references(() => housingRoom.id, { onDelete: 'restrict' }),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    ...timestamps,
  },
  (t) => [
    index('housing_assignment_room_id_idx').on(t.roomId, t.startsOn),
    index('housing_assignment_engagement_id_idx').on(t.engagementId),
    check('housing_assignment_dates_in_order', sql`${t.startsOn} < ${t.endsOn}`),
  ],
)

export const housingPreference = pgTable(
  'housing_preference',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    rule: housingRule('rule').notNull(),
    note: text('note'),
    ...timestamps,
  },
  (t) => [unique('housing_preference_person_rule_uq').on(t.personId, t.rule)],
)

/**
 * The simulated flight feed's clock, one row. Moving it lets a demo replay a
 * travel day ("it's 9 AM on Jan 10") without waiting for one. Only the
 * simulated feed reads it.
 */
export const demoClock = pgTable(
  'demo_clock',
  {
    id: boolean('id').primaryKey().default(true),
    offsetMs: bigint('offset_ms', { mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (t) => [check('demo_clock_single_row', sql`${t.id}`)],
)

// ---------------------------------------------------------------------------
// Contracts. Field groups are in shared/contracts.ts; everything here is in
// the Contracts group.
// ---------------------------------------------------------------------------

/** Raw bytes (a blank union form). Both drivers read and write a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const templateFormat = pgEnum('contract_template_format', TEMPLATE_FORMATS)
export const contractStatus = pgEnum('contract_status', CONTRACT_STATUSES)

/** The theatre's own details, printed on every contract. One row. */
export const organization = pgTable(
  'organization',
  {
    id: integer('id').primaryKey().default(1),
    name: text('name'),
    street: text('street'),
    cityStateZip: text('city_state_zip'),
    phone: text('phone'),
    email: text('email'),
    signerName: text('signer_name'),
    ein: text('ein'),
    unemploymentNumber: text('unemployment_number'),
    equityEmployerAgreement: text('equity_employer_agreement'),
    ...timestamps,
  },
  (t) => [check('organization_single_row', sql`${t.id} = 1`)],
)

/**
 * A contract template. Versions are rows: replacing a template adds a new row
 * in the same family and retires the old one, so a contract always points at
 * exactly the form it was made from.
 */
export const contractTemplate = pgTable(
  'contract_template',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The first version's id, shared by every later version.
    familyId: uuid('family_id').notNull(),
    name: text('name').notNull(),
    format: templateFormat('format').notNull(),
    contractType: contractType('contract_type').notNull(),
    version: integer('version').notNull().default(1),
    // A union form: the blank fillable PDF as uploaded.
    pdf: bytea('pdf'),
    fileName: text('file_name'),
    // A text template: the body, with {{tokens}}.
    body: text('body'),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('contract_template_family_version_uq').on(t.familyId, t.version),
    check(
      'contract_template_content_matches_format',
      sql`(${t.format} = 'text' and ${t.body} is not null and ${t.pdf} is null) or (${t.format} <> 'text' and ${t.pdf} is not null and ${t.body} is null)`,
    ),
  ],
)

/** One contract for one engagement, from one template version. */
export const contract = pgTable(
  'contract',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagement.id, { onDelete: 'cascade' }),
    // Restrict: a template with contracts can be retired, not deleted.
    templateId: uuid('template_id')
      .notNull()
      .references(() => contractTemplate.id, { onDelete: 'restrict' }),
    templateFamilyId: uuid('template_family_id').notNull(),
    status: contractStatus('status').notNull().default('draft'),
    // Values the Company Manager typed over what the app filled in.
    overrides: jsonb('overrides').$type<Record<string, string>>().notNull().default({}),
    // What went out, frozen when marked sent. Personal ID is never kept here.
    sentValues: jsonb('sent_values').$type<Record<string, string>>(),
    sentOn: date('sent_on', { mode: 'string' }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentTo: text('sent_to'),
    signedOn: date('signed_on', { mode: 'string' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('contract_engagement_id_idx').on(t.engagementId),
    index('contract_template_id_idx').on(t.templateId),
    // One live contract per engagement per template; a voided one can be redone.
    uniqueIndex('contract_engagement_family_live_uq')
      .on(t.engagementId, t.templateFamilyId)
      .where(sql`${t.status} <> 'void'`),
    check('contract_sent_has_date', sql`${t.status} in ('draft', 'void') or ${t.sentOn} is not null`),
    check('contract_signed_has_date', sql`${t.status} <> 'signed' or ${t.signedOn} is not null`),
  ],
)

// ---------------------------------------------------------------------------
// Documents: the paperwork checklist and the handoff to Finance. Statuses are
// the documents group; the files are tax_bank and are encrypted before they
// reach this table.
// ---------------------------------------------------------------------------

export const documentType = pgEnum('document_type', DOCUMENT_TYPES)
export const documentStatus = pgEnum('document_status', DOCUMENT_STATUSES)

/** Which forms each contract type needs. The Company Manager edits this. */
export const documentRequirement = pgTable(
  'document_requirement',
  {
    contractType: contractType('contract_type').notNull(),
    documentType: documentType('document_type').notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.contractType, t.documentType] })],
)

/**
 * One form for one engagement. A row exists once something has happened to
 * it; a required form with no row is Missing.
 */
export const document = pgTable(
  'document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagement.id, { onDelete: 'cascade' }),
    documentType: documentType('document_type').notNull(),
    status: documentStatus('status').notNull().default('missing'),
    receivedOn: date('received_on', { mode: 'string' }),
    // 'upload_link' or 'company_manager'.
    receivedVia: text('received_via'),
    sentToFinanceAt: timestamp('sent_to_finance_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    // When the file was deleted (accepted, removed or past retention).
    filePurgedAt: timestamp('file_purged_at', { withTimezone: true }),
    // Finance's note when it sends a form back.
    financeNote: text('finance_note'),
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('document_engagement_type_uq').on(t.engagementId, t.documentType),
    index('document_status_idx').on(t.status),
    check('document_received_has_date', sql`${t.status} in ('missing', 'not_needed') or ${t.receivedOn} is not null`),
    check('document_sent_has_time', sql`${t.status} <> 'sent_to_finance' or ${t.sentToFinanceAt} is not null`),
    check('document_accepted_has_time', sql`${t.status} <> 'accepted' or ${t.acceptedAt} is not null`),
  ],
)

/**
 * The file for one document, held only until Finance accepts it. The bytes
 * and the file name are both encrypted with the field key; the row's id is
 * bound in so a file can't be moved to another document.
 */
export const documentFile = pgTable('document_file', {
  documentId: uuid('document_id')
    .primaryKey()
    .references(() => document.id, { onDelete: 'cascade' }),
  // iv (12 bytes) | tag (16 bytes) | ciphertext
  data: bytea('data').notNull(),
  fileNameEnc: text('file_name_enc').notNull(),
  mime: text('mime').notNull(),
  bytes: integer('bytes').notNull(),
  uploadedBy: text('uploaded_by'),
  ...timestamps,
})

/**
 * A link the Company Manager sends so a person can upload their own forms
 * without an account. Only a hash of the token is kept.
 */
export const uploadLink = pgTable(
  'upload_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagement.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    documentTypes: documentType('document_types').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    uploads: integer('uploads').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('upload_link_token_hash_uq').on(t.tokenHash),
    index('upload_link_engagement_id_idx').on(t.engagementId),
  ],
)

/** Documents settings. One row. */
export const documentSettings = pgTable(
  'document_settings',
  {
    id: integer('id').primaryKey().default(1),
    linkDays: integer('link_days').notNull().default(14),
    retentionYears: integer('retention_years').notNull().default(3),
    // False until Finance confirms how long forms may be held.
    retentionConfirmed: boolean('retention_confirmed').notNull().default(false),
    lastPurgeAt: timestamp('last_purge_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('document_settings_single_row', sql`${t.id} = 1`),
    check('document_settings_link_days', sql`${t.linkDays} between 1 and 60`),
    check('document_settings_retention', sql`${t.retentionYears} between 1 and 10`),
  ],
)
