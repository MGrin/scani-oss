import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { holdingGroups } from './groups';
import { tokens } from './tokens';
import { users } from './users';
import { vaultHoldings } from './vaults';

// Per-user position rows: a single (account, token) holding with a balance.
// Hidden holdings are excluded from queries but still updated by cron;
// inactive holdings are visible but excluded from total calculations.
export const holdings = pgTable(
  'holdings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }), // Prevent token deletion if holdings exist
    balance: text('balance').notNull(), // Store as string for Decimal.js precision
    source: text('source').notNull().default('manual'), // 'blockchain' or 'manual' - tracks origin of holding
    externalId: text('external_id'), // Exchange-specific asset identifier for synced holdings (e.g., 'BTC' for Binance). NULL for manual holdings.
    isHidden: boolean('is_hidden').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('idx_holdings_user_id').on(table.userId),
    accountIdIdx: index('idx_holdings_account_id').on(table.accountId),
    tokenIdIdx: index('idx_holdings_token_id').on(table.tokenId),
    userAccountTokenIdx: index('idx_holdings_user_account_token').on(
      table.userId,
      table.accountId,
      table.tokenId
    ),
    userTokenIdx: index('idx_holdings_user_token').on(table.userId, table.tokenId),
    userCreatedAtIdx: index('idx_holdings_user_created_at').on(
      table.userId,
      table.createdAt.desc()
    ),
    isHiddenIdx: index('idx_holdings_is_hidden').on(table.isHidden),
    isActiveIdx: index('idx_holdings_is_active').on(table.isActive),
    // Sync matching index: (account_id, token_id, external_id)
    accountTokenExternalIdx: index('idx_holdings_account_token_external').on(
      table.accountId,
      table.tokenId,
      table.externalId
    ),
  })
);

// =============================================================================
// HISTORICAL PNL — ledger, observations, coverage (migration 0053)
// =============================================================================

// The authoritative ledger of every economic event we ingest from any
// source: chain tx, CEX trade, statement line, screenshot extraction,
// manual entry, plus synthesized 'opening_balance' rows from
// reconciliation. Never overrides holdings.balance — strictly additive.
export const holdingTransactions = pgTable(
  'holding_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Primary relational anchor — the position this event belongs to.
    // `holdings.id` fans out to the account + token via JOIN and keeps
    // the ledger compatible with multi-lot / multi-holding-per-(account,
    // token) scenarios. Migration 0054 dropped the old account_id column
    // in favor of this key; use `holdings.accountId` for per-account
    // aggregation.
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' }),
    // Same as holdings.tokenId, denormalized for query ergonomics: the
    // row also carries counterTokenId + feeTokenId, so a single tokenId
    // column alongside keeps "show all BTC trades" queries from needing
    // a holdings JOIN. Ingesters MUST keep this in sync with the
    // referenced holding's token.
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }),
    // buy|sell|deposit|withdraw|transfer_in|transfer_out|swap_in|swap_out|
    // fee|reward|interest|airdrop|opening_balance|unknown
    kind: text('kind').notNull(),
    // Signed Decimal.js string. Negative for outflows (sell, withdraw, fee).
    quantity: text('quantity').notNull(),
    // Per-unit price at tx time, stored in its NATIVE quote currency.
    // E.g. a Kraken BTC/EUR trade has priceNativeTokenId = EUR.
    priceNative: text('price_native'),
    // ON DELETE SET NULL on the price / counter / fee token refs — they
    // are informational only. If the referenced token is merged or
    // dedup-deleted (migrations 0006 / 0007) we'd rather null the
    // reference than block the delete. The primary `token_id` above
    // stays ON DELETE RESTRICT.
    priceNativeTokenId: uuid('price_native_token_id').references(() => tokens.id, {
      onDelete: 'set null',
    }),
    // For trades / swaps: the other side of the transaction.
    counterTokenId: uuid('counter_token_id').references(() => tokens.id, {
      onDelete: 'set null',
    }),
    counterQuantity: text('counter_quantity'),
    counterPriceNative: text('counter_price_native'),
    counterPriceNativeTokenId: uuid('counter_price_native_token_id').references(() => tokens.id, {
      onDelete: 'set null',
    }),
    // Fees in their native token.
    feeQuantity: text('fee_quantity'),
    feeTokenId: uuid('fee_token_id').references(() => tokens.id, { onDelete: 'set null' }),
    // When the tx actually happened per the source (not our ingest time).
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    // Chain tx hash / exchange trade id / bank tx id — for dedup across
    // re-ingests. NOT NULL so the unique constraint on (holding_id,
    // source, external_id) is meaningful: Postgres treats nullable
    // columns as distinct in uniqueness, which would allow unbounded
    // duplicates on re-ingest. Every ingester must synthesize a stable
    // id when the source doesn't provide one.
    externalId: text('external_id').notNull(),
    // Links both legs of a swap.
    swapGroupId: uuid('swap_group_id'),
    // Links CEX withdraw ↔ wallet deposit (populated by Phase 3 matcher).
    transferGroupId: uuid('transfer_group_id'),
    // 'binance-api' | 'etherscan' | 'statement-csv' | 'screenshot' |
    // 'user-entered' | 'reconciliation-opening' | ...
    source: text('source').notNull(),
    sourceMetadata: jsonb('source_metadata').notNull().default('{}'),
    // Original payload for forensics / re-parse after normalizer improvements.
    rawPayload: jsonb('raw_payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dedup: unique('holding_tx_dedup').on(table.holdingId, table.source, table.externalId),
    userOccurredIdx: index('idx_holding_tx_user_occurred').on(
      table.userId,
      table.occurredAt.desc()
    ),
    holdingOccurredIdx: index('idx_holding_tx_holding_occurred').on(
      table.holdingId,
      table.occurredAt.desc()
    ),
    transferGroupIdx: index('idx_holding_tx_transfer_group').on(table.transferGroupId),
    swapGroupIdx: index('idx_holding_tx_swap_group').on(table.swapGroupId),
  })
);

// Append-only point-in-time balance truth. Used as anchors to derive
// balance at any past time. Sources: 'sync-capture' (every live sync
// appends one), 'statement-close' (closing balance from an uploaded
// statement), 'screenshot' (extracted via AI vision), 'user-entered',
// 'manual-correction'.
export const holdingBalanceObservations = pgTable(
  'holding_balance_observations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Position this observation describes. account_id + token_id removed
    // in migration 0054 — they're derivable from holdings.
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' }),
    balance: text('balance').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    source: text('source').notNull(),
    sourceMetadata: jsonb('source_metadata').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dedup: unique('holding_obs_dedup').on(table.holdingId, table.observedAt, table.source),
    holdingObservedIdx: index('idx_holding_obs_holding_observed').on(
      table.holdingId,
      table.observedAt.desc()
    ),
    userObservedIdx: index('idx_holding_obs_user_observed').on(
      table.userId,
      table.observedAt.desc()
    ),
  })
);

// Per-holding history metadata — drives data-quality UI, reconciliation
// triggers, and the set of tokens × dates for which we need historical
// prices. Migration 0054 keyed this on `holdings.id` (was previously
// (account_id, token_id) composite, which broke for multi-holding-per-
// (account, token) cases).
export const holdingCoverage = pgTable('holding_coverage', {
  holdingId: uuid('holding_id')
    .primaryKey()
    .references(() => holdings.id, { onDelete: 'cascade' }),
  firstTxAt: timestamp('first_tx_at', { withTimezone: true }),
  lastTxAt: timestamp('last_tx_at', { withTimezone: true }),
  firstObservationAt: timestamp('first_observation_at', { withTimezone: true }),
  lastObservationAt: timestamp('last_observation_at', { withTimezone: true }),
  // Names of ingester sources that have contributed — e.g.
  // ['etherscan', 'binance-api'].
  txSources: text('tx_sources').array().notNull().default(sql`'{}'`),
  hasCompleteTxHistory: boolean('has_complete_tx_history').notNull().default(false),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  // The synthesized opening balance (positive or negative Decimal.js
  // string), or null if reconciliation has not yet run or sum(txs)
  // matched observation.
  openingBalanceQuantity: text('opening_balance_quantity'),
  reconciliationNotes: text('reconciliation_notes'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Per-holding interest/yield configuration. One APY config per holding;
// payouts are applied by the apy-payouts cron job.
export const holdingApyConfigs = pgTable(
  'holding_apy_configs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' })
      .unique(),
    annualRatePct: text('annual_rate_pct').notNull(), // Decimal string, e.g. "4.5" for 4.5%
    payoutFrequency: text('payout_frequency').notNull(), // 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
    payoutDayOfWeek: real('payout_day_of_week'), // 0=Sun..6=Sat, for 'weekly'
    payoutDayOfMonth: real('payout_day_of_month'), // 1-31, for 'monthly' and 'yearly'
    payoutMonth: real('payout_month'), // 1-12, for 'yearly'
    lastPayoutAt: timestamp('last_payout_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    holdingIdIdx: index('idx_holding_apy_configs_holding_id').on(table.holdingId),
    activeIdx: index('idx_holding_apy_configs_active').on(table.isActive),
  })
);

export const holdingsRelations = relations(holdings, ({ one, many }) => ({
  user: one(users, {
    fields: [holdings.userId],
    references: [users.id],
  }),
  account: one(accounts, {
    fields: [holdings.accountId],
    references: [accounts.id],
  }),
  token: one(tokens, {
    fields: [holdings.tokenId],
    references: [tokens.id],
  }),
  holdingGroups: many(holdingGroups),
  vaultHoldings: many(vaultHoldings),
  apyConfig: one(holdingApyConfigs, {
    fields: [holdings.id],
    references: [holdingApyConfigs.holdingId],
  }),
}));

export const holdingTransactionsRelations = relations(holdingTransactions, ({ one }) => ({
  user: one(users, {
    fields: [holdingTransactions.userId],
    references: [users.id],
  }),
  holding: one(holdings, {
    fields: [holdingTransactions.holdingId],
    references: [holdings.id],
  }),
  token: one(tokens, {
    fields: [holdingTransactions.tokenId],
    references: [tokens.id],
  }),
}));

export const holdingBalanceObservationsRelations = relations(
  holdingBalanceObservations,
  ({ one }) => ({
    user: one(users, {
      fields: [holdingBalanceObservations.userId],
      references: [users.id],
    }),
    holding: one(holdings, {
      fields: [holdingBalanceObservations.holdingId],
      references: [holdings.id],
    }),
  })
);

export const holdingCoverageRelations = relations(holdingCoverage, ({ one }) => ({
  holding: one(holdings, {
    fields: [holdingCoverage.holdingId],
    references: [holdings.id],
  }),
}));

export const holdingApyConfigsRelations = relations(holdingApyConfigs, ({ one }) => ({
  holding: one(holdings, {
    fields: [holdingApyConfigs.holdingId],
    references: [holdings.id],
  }),
}));

export type Holding = typeof holdings.$inferSelect;
export type NewHolding = typeof holdings.$inferInsert;
export type HoldingTransaction = typeof holdingTransactions.$inferSelect;
export type NewHoldingTransaction = typeof holdingTransactions.$inferInsert;
export type HoldingBalanceObservation = typeof holdingBalanceObservations.$inferSelect;
export type NewHoldingBalanceObservation = typeof holdingBalanceObservations.$inferInsert;
export type HoldingCoverage = typeof holdingCoverage.$inferSelect;
export type NewHoldingCoverage = typeof holdingCoverage.$inferInsert;
export type HoldingApyConfig = typeof holdingApyConfigs.$inferSelect;
export type NewHoldingApyConfig = typeof holdingApyConfigs.$inferInsert;

// Valid values for holding_transactions.kind. Broader than a pgEnum on
// purpose — new ingesters may introduce new kinds (e.g. 'rebase',
// 'slash') without requiring a schema migration. Readers should tolerate
// unknown kinds.
export type HoldingTransactionKind =
  | 'buy'
  | 'sell'
  | 'deposit'
  | 'withdraw'
  | 'transfer_in'
  | 'transfer_out'
  | 'swap_in'
  | 'swap_out'
  | 'fee'
  | 'reward'
  | 'interest'
  | 'airdrop'
  | 'opening_balance'
  | 'unknown';
