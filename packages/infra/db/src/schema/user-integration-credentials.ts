import { relations } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { institutions } from './institutions';
import { users } from './users';

// Enum created by migration 0046. Declared here so Drizzle binds
// parameters with the correct Postgres type — without this,
// `eq(importStatus, 'pending_enqueue')` fails with
// `operator does not exist: credentials_import_status = text`.
export const credentialsImportStatusEnum = pgEnum('credentials_import_status', [
  'pending_enqueue',
  'enqueued',
  'failed',
]);

// Stores encrypted OAuth tokens / API keys / RPC creds per (user,
// institution). The `encryptedCredentials` jsonb is AES-GCM encrypted
// at rest by IntegrationCredentialsService before insert; reads decrypt
// on demand.
//
// `importStatus` participates in the orphan-reconciliation flow (see
// migration 0046): the api inserts the row with `pending_enqueue`,
// calls BullMQ.add(), and promotes to `enqueued`. If the api dies in
// between, the per-minute reconciler sweeper picks up stale rows.
export const userIntegrationCredentials = pgTable(
  'user_integration_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    encryptedCredentials: jsonb('encrypted_credentials').notNull(),
    credentialsType: text('credentials_type').notNull(), // 'oauth', 'api_key', 'rpc', etc.
    isActive: boolean('is_active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }), // For OAuth tokens with expiration
    importStatus: credentialsImportStatusEnum('import_status').notNull().default('enqueued'),
    importJobId: text('import_job_id'),
    importEnqueuedAt: timestamp('import_enqueued_at', { withTimezone: true }),
    importLastError: text('import_last_error'),
    importRetryCount: integer('import_retry_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserInstitution: unique().on(table.userId, table.institutionId),
    userIdIdx: index('idx_user_integration_credentials_user_id').on(table.userId),
    institutionIdIdx: index('idx_user_integration_credentials_institution_id').on(
      table.institutionId
    ),
    userInstitutionIdx: index('idx_user_integration_credentials_user_institution').on(
      table.userId,
      table.institutionId
    ),
  })
);

// =============================================================================
// CredentialPool — bookkeeping for cross-user credential pool (migration 0055)
// =============================================================================
//
// Per-(user, institution) entry tracking LRU + quarantine state for the
// credential pool that backs pool-credentialed reads (pricing, token
// identity) across all users. See @scani/providers/core/credential-pool.ts.
// Lives outside user_integration_credentials because it changes on every
// borrow and would thrash that table's encrypted-payload indexes.
export const credentialPoolState = pgTable(
  'credential_pool_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    // LRU selector — borrows pick the smallest non-null (or null) value.
    lastBorrowedAt: timestamp('last_borrowed_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    // Transient back-off window. Entry is excluded from selection while
    // now() < quarantinedUntil.
    quarantinedUntil: timestamp('quarantined_until', { withTimezone: true }),
    totalBorrowsCount: integer('total_borrows_count').notNull().default(0),
    totalFailuresCount: integer('total_failures_count').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.institutionId] }),
    // Note: the partial LRU index used by the selector is created in
    // the migration directly (Drizzle's index() doesn't support WHERE).
  })
);

// Append-only audit of every pool borrow. No read paths in this PR; a
// future work session will surface borrow stats to users.
export const credentialPoolBorrowLog = pgTable(
  'credential_pool_borrow_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    providerKey: text('provider_key').notNull(),
    borrowedFromUserId: uuid('borrowed_from_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    borrowedAt: timestamp('borrowed_at', { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer('duration_ms'),
    /** 'ok' | 'auth-failed' | 'rate-limited' | 'transient-error' */
    outcome: text('outcome').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('credential_pool_borrow_log_user_idx').on(
      table.borrowedFromUserId,
      table.borrowedAt.desc()
    ),
    providerIdx: index('credential_pool_borrow_log_provider_idx').on(
      table.providerKey,
      table.borrowedAt.desc()
    ),
  })
);

export const userIntegrationCredentialsRelations = relations(
  userIntegrationCredentials,
  ({ one }) => ({
    user: one(users, {
      fields: [userIntegrationCredentials.userId],
      references: [users.id],
    }),
    institution: one(institutions, {
      fields: [userIntegrationCredentials.institutionId],
      references: [institutions.id],
    }),
  })
);

export type UserIntegrationCredentials = typeof userIntegrationCredentials.$inferSelect;
export type NewUserIntegrationCredentials = typeof userIntegrationCredentials.$inferInsert;
