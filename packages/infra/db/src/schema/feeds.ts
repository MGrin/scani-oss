import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { userIntegrationCredentials } from './user-integration-credentials';
import { userWallets } from './user-wallets';
import { users } from './users';

export type FeedInputStatus = 'active' | 'disconnected';

// One row per source feeding an account: a provider code, a statement upload.
// The input is the account's, so it goes with the account; the credential and
// wallet it names are references, and losing either clears the reference
// rather than the input. `status` is CHECK-constrained in the migration, as
// are the vocabularies on the tables below.
export const feedInputs = pgTable(
  'feed_inputs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    credentialId: uuid('credential_id').references(() => userIntegrationCredentials.id, {
      onDelete: 'set null',
    }),
    walletId: uuid('wallet_id').references(() => userWallets.id, { onDelete: 'set null' }),
    status: text('status').$type<FeedInputStatus>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountSourceUq: unique('feed_inputs_account_source_uq').on(table.accountId, table.source),
    userIdIdx: index('idx_feed_inputs_user_id').on(table.userId),
  })
);

// One row per fetch or upload. `from_at` and `to_at` because `from` and `to`
// are reserved words; a NULL `from_at` is an unbounded start, and `to_at` is
// never open. A fetch records at most one window, and an open start is a value
// there: two NULL `from_at` are the same window.
const FEED_WINDOW_SHAPES = ['balance-snapshot', 'statement-upload', 'transaction-run'] as const;
export type FeedWindowShape = (typeof FEED_WINDOW_SHAPES)[number];

export const feedInputWindows = pgTable(
  'feed_input_windows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inputId: uuid('input_id')
      .notNull()
      .references(() => feedInputs.id, { onDelete: 'cascade' }),
    fromAt: timestamp('from_at', { withTimezone: true }),
    toAt: timestamp('to_at', { withTimezone: true }).notNull(),
    complete: boolean('complete').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    uploadRef: text('upload_ref'),
    // NULL on rows written before SC-1665; the ledger read-through reads 'transaction-run' only.
    shape: text('shape').$type<FeedWindowShape>(),
  },
  (table) => ({
    inputToIdx: index('idx_feed_input_windows_input_to').on(table.inputId, table.toAt.desc()),
    // Drizzle cannot express NULLS NOT DISTINCT on an index; the migration is the source of truth for that clause.
    fetchUq: uniqueIndex('feed_input_windows_fetch_uq').on(
      table.inputId,
      table.fromAt,
      table.toAt,
      table.fetchedAt
    ),
  })
);

// A person's standing sentence about one input: a description or counterparty
// pattern that means a destination account, a ledger kind, or both. Written
// only by a person or by confirming a proposal; the CHECK that it names at
// least one of the two lives in the migration.
export const feedMatchRules = pgTable(
  'feed_match_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    inputId: uuid('input_id')
      .notNull()
      .references(() => feedInputs.id, { onDelete: 'cascade' }),
    matchField: text('match_field').$type<'description' | 'counterparty'>().notNull(),
    pattern: text('pattern').notNull(),
    destinationAccountId: uuid('destination_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    ledgerKind: text('ledger_kind'),
    createdBy: text('created_by').$type<'person' | 'proposal-confirmed'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    inputFieldPatternUq: unique('feed_match_rules_input_field_pattern_uq').on(
      table.inputId,
      table.matchField,
      table.pattern
    ),
    userIdIdx: index('idx_feed_match_rules_user_id').on(table.userId),
  })
);

// One row per stored judgment. The unique key is the question, its version, the
// exact bytes sent and the pinned model, so asking the same thing of the same
// state twice stores one answer.
export const judgmentDecisions = pgTable(
  'judgment_decisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionKey: text('question_key').notNull(),
    questionVersion: integer('question_version').notNull(),
    stateHash: text('state_hash').notNull(),
    modelId: text('model_id').notNull(),
    answer: text('answer').notNull(),
    probabilities: jsonb('probabilities').notNull(),
    applied: text('applied')
      .$type<'auto' | 'proposed' | 'confirmed' | 'overridden' | 'rejected'>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneAnswerPerQuestionStateUq: unique('judgment_decisions_one_per_question_state_uq').on(
      table.userId,
      table.questionKey,
      table.questionVersion,
      table.stateHash,
      table.modelId
    ),
  })
);

// An event written in the same transaction as the data it describes.
// `user_id` is nullable because a price event belongs to no user.
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => ({
    unpublishedIdx: index('idx_outbox_events_unpublished')
      .on(table.id)
      .where(sql`published_at IS NULL`),
    userIdIdx: index('idx_outbox_events_user_id').on(table.userId),
  })
);

export type FeedInput = typeof feedInputs.$inferSelect;
export type NewFeedInput = typeof feedInputs.$inferInsert;
export type FeedInputWindow = typeof feedInputWindows.$inferSelect;
export type NewFeedInputWindow = typeof feedInputWindows.$inferInsert;
export type FeedMatchRule = typeof feedMatchRules.$inferSelect;
export type NewFeedMatchRule = typeof feedMatchRules.$inferInsert;
export type JudgmentDecision = typeof judgmentDecisions.$inferSelect;
export type NewJudgmentDecision = typeof judgmentDecisions.$inferInsert;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
