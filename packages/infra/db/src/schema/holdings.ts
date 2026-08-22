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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { holdingGroups } from './groups';
import { tokens } from './tokens';
import { transferReviewRules } from './transfer-review-rules';
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
    // `source` says which system wrote the row; `arrival` says whether a
    // human ever picked it, and on a public chain those are different
    // questions — the wallet-import review and the hourly auto-discovering
    // sync both wrote `source = 'blockchain'`. A signal, never a verdict:
    // 2 of the 17 rows migration 0042 backfills are legitimate. SC-277.
    arrival: text('arrival').notNull().default('unattributed'),
    externalId: text('external_id'), // Exchange-specific asset identifier for synced holdings (e.g., 'BTC' for Binance). NULL for manual holdings.
    // What the user calls this pot ("Savings", "Wedding gift"). NULL is the
    // ordinary case; it earns its keep only when an account holds several rows
    // for one token, where it is the difference between four positions and one
    // typed four times. `external_id` cannot serve: it is the address an
    // importer dedupes on, and inventing one for a hand-entered row makes that
    // row a sync target (SC-330).
    label: text('label'),
    isHidden: boolean('is_hidden').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    // What the owner last said a manual balance edit on THIS holding meant —
    // 'flow' | 'correction' | 'growth' (SC-510). The remembered default for
    // the next edit, so the second month of a monthly savings update is one
    // tap rather than the same three-way question again.
    //
    // NULL means never asked, and the API treats it that way: an ambiguous
    // holding with no answer and no remembered cause is refused rather than
    // guessed at. `manualEditNeedsCause` in @scani/shared is which holdings
    // that applies to and why.
    manualEditCause: text('manual_edit_cause'),
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
    // One row per externally-addressed position (migration 0043, SC-325).
    // `external_id` is the key an importer dedupes on, so two rows sharing one
    // mean the importer forked its own position and every later sync lands on
    // whichever `findByAccountTokenAndExternalId` happens to return first.
    //
    // PARTIAL on purpose: a row with no external_id is not addressable by any
    // importer, so this says nothing about it. Production holds four manual RUB
    // rows in one Tinkoff account that the user maintains independently — a
    // `NULLS NOT DISTINCT` key would forbid them, and no automatic repair keeps
    // all four. Whether a second hand-entered row is allowed is a product
    // policy, enforced where those rows are created
    // (`CreateHoldingsWithDependenciesUseCase`, SC-303), not here.
    accountTokenExternalUq: uniqueIndex('holdings_account_token_external_uq')
      .on(table.accountId, table.tokenId, table.externalId)
      .where(sql`external_id IS NOT NULL`),
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
    // fee|reward|interest|airdrop|opening_balance|correction|unknown
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
    // The user's answer to "what actually happened to this outflow", for the
    // ones `LinkTransferPairsUseCase` could not pair on its own — see
    // TRANSFER_REVIEW_DECISIONS in @scani/shared for the three values.
    //
    // Only outflow rows ever carry it, and only a human writes it: the
    // matcher may set `transfer_group_id` but never this column, so
    // `transfer_review IS NOT NULL` means a person decided. That asymmetry is
    // the point — it is what lets the matcher skip a row it would otherwise
    // re-examine every night, and what stops a later heuristic run from
    // quietly overruling an answer someone gave.
    transferReview: text('transfer_review'),
    transferReviewedAt: timestamp('transfer_reviewed_at', { withTimezone: true }),
    // WHO decided, when the answer did not come from the person whose row it is
    // (SC-350). `AnswerSource` in @scani/shared is the vocabulary and carries
    // the full reasoning; the short version is that provenance had exactly two
    // representable states — stamped meant "the user, in the queue" and
    // unstamped meant "not through the queue at all" — and a correction Scani
    // makes on the user's behalf is neither. Writing the stamp would forge his
    // answer; leaving it null would file the correction alongside the 560-row
    // raw UPDATE this vocabulary exists to tell apart.
    //
    // NULL is the whole of the existing corpus and keeps its exact meaning:
    // read it as `transfer_reviewed_at IS NOT NULL ? 'user' : 'unattributed'`.
    // So nothing is backfilled and no row's provenance changes by adding this.
    transferReviewSource: text('transfer_review_source'),
    // WHICH standing rule answered it, when `transfer_review_source` is
    // `'rule'` (SC-380). A database CHECK ties the two together in both
    // directions, because the direction that gets forgotten is the undo: a
    // per-row undo leaves the source reading `'user'`, and a rule id surviving
    // that would let the answered list go on naming a rule for an answer that
    // is no longer on the row.
    //
    // Not merely "a rule did this". The sentence this whole feature exists to
    // preserve is mgrin's about 560 already-answered transfers — "I honestly
    // can not remember that anymore anyway" — and a row that cannot name the
    // rule cannot repeat back the note he wrote about the destination, which
    // is the only part of it he will still understand in three years.
    transferReviewRuleId: uuid('transfer_review_rule_id').references(() => transferReviewRules.id, {
      onDelete: 'set null',
    }),
    // The same answer, divided (SC-181). A withdrawal of 4,000 can be 3,500
    // moved to an account Scani cannot see and 500 that genuinely left, and
    // every answer above applies to the whole row — so the lesser wrong had to
    // be picked, overstating by 3,500 or understating by 500.
    //
    // Set together with `transfer_review = 'split'` and never apart: the
    // column above is what the queue predicate and the matcher read, and a
    // split with a NULL review would be a row that is answered and in the
    // queue at once. `TransferReviewSplit` in @scani/shared is the shape;
    // portions are unsigned token quantities that must sum EXACTLY to
    // |quantity|, checked on write against this very row.
    transferReviewSplit: jsonb('transfer_review_split'),
    // 'binance-api' | 'etherscan' | 'statement-csv' | 'screenshot' |
    // 'user-entered' | 'reconciliation-opening' | ...
    source: text('source').notNull(),
    sourceMetadata: jsonb('source_metadata').notNull().default('{}'),
    // Original payload for forensics / re-parse after normalizer improvements.
    rawPayload: jsonb('raw_payload'),
    // Who the money moved to/from, normalised by the provider adapter.
    // Asset-centric sources (chain swaps, exchange trades) leave it null;
    // that is expected, not a gap to backfill.
    counterparty: text('counterparty'),
    description: text('description'),
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
    // The transfer-review queue's own read: unpaired, undecided outflows for
    // one user, newest first. Partial because that set is a rounding error
    // next to the table — every paired outflow, every answered one and every
    // inflow stays out of the index.
    transferReviewPendingIdx: index('idx_holding_tx_transfer_review_pending')
      .on(table.userId, table.occurredAt.desc())
      .where(
        sql`transfer_group_id IS NULL AND transfer_review IS NULL AND kind IN ('withdraw', 'transfer_out')`
      ),
    // Every row one rule has answered, for its answered count and for the
    // withdraw half of `revoke` (SC-380). Partial because the column is null on
    // every row no rule has ever touched, which today is all of them.
    transferReviewRuleIdx: index('idx_holding_tx_transfer_review_rule')
      .on(table.transferReviewRuleId)
      .where(sql`transfer_review_rule_id IS NOT NULL`),
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
    // The owner's answer to "we think money moved here — tell us" for the
    // interval this observation CLOSES (SC-501). A gap is a pair of
    // consecutive observations whose difference the ledger does not explain,
    // and the pair is determined by its later row — so the answer lives here
    // and there is no second record to keep in step with the observations
    // that define the question.
    //
    // `BALANCE_GAP_ANSWERS` in @scani/shared is the vocabulary: the three
    // `MANUAL_EDIT_CAUSES` verbatim, plus `unknown`. Only a human writes it,
    // exactly as with `transfer_review` above, so NOT NULL means a person
    // decided and no importer or nightly job may overrule them.
    //
    // Writing NULL back is deliberately still possible — see the migration.
    // An answer that can only be given once is how a guess becomes permanent.
    gapReview: text('gap_review'),
    gapReviewedAt: timestamp('gap_reviewed_at', { withTimezone: true }),
    // WHO answered, when it was not the owner in the queue — the same
    // `AnswerSource` vocabulary and the same reasoning as
    // `transfer_review_source`. NULL reads as `gap_reviewed_at IS NOT NULL ?
    // 'user' : 'unattributed'`, so nothing is backfilled.
    gapReviewSource: text('gap_review_source'),
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
    // The balance-gap queue's own read: one user's observations in the order
    // the drift window partitions and sorts by, with `balance` carried so the
    // walk is index-only (SC-501).
    userHoldingObservedIdx: index('idx_holding_obs_user_holding_observed').on(
      table.userId,
      table.holdingId,
      table.observedAt
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
  // A restatement, not an event: the previously recorded balance was wrong
  // (SC-510). Written only by `ManualBalanceEditService`, dated at the moment
  // the superseded figure entered the record rather than at the edit, and
  // classified `restatement` by `flowRoleOf` — subtracted from the value
  // series like a flow so it is not read as a gain, and kept out of the
  // investor's cashflows so it is not read as money paid in.
  | 'correction'
  | 'unknown';
