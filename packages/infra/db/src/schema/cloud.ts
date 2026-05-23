import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// =============================================================================
// CLOUD (data-provider service) — Better-Auth user store + API key registry
// + append-only per-request usage log.
// =============================================================================
//
// Tables are prefixed `cloud_` so they live alongside the backend's own
// auth tables in the same Postgres DB without collision. OSS Tier 1
// never populates these; Tier 2/3 swaps the env-based bearer check for
// a DB lookup against `cloud_api_keys`.
// Migrations: 0050_cloud_api_keys.sql

export const cloudUsers = pgTable('cloud_users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  name: text('name'),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const cloudSessions = pgTable(
  'cloud_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => cloudUsers.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('cloud_sessions_user_id_idx').on(t.userId),
    tokenIdx: index('cloud_sessions_token_idx').on(t.token),
  })
);

export const cloudAccounts = pgTable(
  'cloud_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => cloudUsers.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('cloud_accounts_user_id_idx').on(t.userId),
  })
);

export const cloudVerifications = pgTable(
  'cloud_verifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    identifierIdx: index('cloud_verifications_identifier_idx').on(t.identifier),
  })
);

export const cloudApiKeys = pgTable(
  'cloud_api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => cloudUsers.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    hashedKey: text('hashed_key').notNull().unique(),
    tier: text('tier').notNull().default('free'),
    billingStatus: text('billing_status').notNull().default('active'),
    quotaMonthlyRequests: integer('quota_monthly_requests'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerUserIdIdx: index('cloud_api_keys_owner_user_id_idx').on(t.ownerUserId),
    tenantIdIdx: index('cloud_api_keys_tenant_id_idx').on(t.tenantId),
  })
);

// Append-only per-request usage log for the cloud-frontend /usage
// dashboard. The data-provider inserts rows and aggregates in SQL (no
// third-party meter SaaS). `subject` is the billable id (e.g.
// cloud_users.id). Migration: 0051_cloud_usage_events.sql
export const cloudUsageEvents = pgTable(
  'cloud_usage_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    subject: text('subject').notNull(),
    apiKeyId: text('api_key_id'),
    tenantId: text('tenant_id'),
    requestId: text('request_id'),
    route: text('route').notNull(),
    provider: text('provider').notNull(),
    outcome: text('outcome').notNull(),
    statusCode: integer('status_code'),
    durationMs: integer('duration_ms').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    bytesIn: integer('bytes_in'),
    bytesOut: integer('bytes_out'),
    upstreamCostUsd: real('upstream_cost_usd'),
    errorCode: text('error_code'),
    metadata: jsonb('metadata'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subjectOccurredIdx: index('cloud_usage_events_subject_occurred_at_idx').on(
      t.subject,
      t.occurredAt
    ),
  })
);

export type CloudUser = typeof cloudUsers.$inferSelect;
export type NewCloudUser = typeof cloudUsers.$inferInsert;
export type CloudSession = typeof cloudSessions.$inferSelect;
export type CloudAccount = typeof cloudAccounts.$inferSelect;
export type CloudVerification = typeof cloudVerifications.$inferSelect;
export type CloudApiKey = typeof cloudApiKeys.$inferSelect;
export type NewCloudApiKey = typeof cloudApiKeys.$inferInsert;
export type CloudUsageEvent = typeof cloudUsageEvents.$inferSelect;
export type NewCloudUsageEvent = typeof cloudUsageEvents.$inferInsert;
export type CloudApiKeyTier = 'free' | 'starter' | 'pro' | 'enterprise' | 'internal';
export type CloudApiKeyBillingStatus = 'active' | 'past_due' | 'suspended' | 'cancelled';
