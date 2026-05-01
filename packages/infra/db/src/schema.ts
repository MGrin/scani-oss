import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Enum created by migration 0046_credentials_import_status.sql. Declared
// here so Drizzle binds parameters with the correct Postgres type — without
// this, `eq(importStatus, 'pending_enqueue')` fails with
// `operator does not exist: credentials_import_status = text`.
export const credentialsImportStatusEnum = pgEnum('credentials_import_status', [
  'pending_enqueue',
  'enqueued',
  'failed',
]);

// Enum created by migration 0047_user_jobs.sql. Same pgEnum-binding rule as
// above — `eq(userJobs.state, 'active')` breaks on a `text` binding.
export const userJobStateEnum = pgEnum('user_job_state', [
  'queued',
  'active',
  'progress',
  'completed',
  'failed',
]);

// =============================================================================
// ENUM TABLES - Dynamic enum values stored in database
// =============================================================================

// Institution types table - dynamic enum values
export const institutionTypes = pgTable('institution_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'bank', 'broker', etc. - for programmatic use
  name: text('name').notNull(), // 'Bank', 'Broker', etc. - for display
  description: text('description'), // Optional description
  displayOrder: real('display_order').notNull().default(0), // For UI ordering
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Account types table - dynamic enum values
export const accountTypes = pgTable('account_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'checking', 'savings', etc.
  name: text('name').notNull(), // 'Checking Account', 'Savings Account', etc.
  description: text('description'),
  displayOrder: real('display_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Token types table - dynamic enum values
export const tokenTypes = pgTable('token_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'fiat', 'crypto', etc.
  name: text('name').notNull(), // 'Fiat Currency', 'Cryptocurrency', etc.
  description: text('description'),
  displayOrder: real('display_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// =============================================================================
// MAIN TABLES
// =============================================================================

// Users table
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  name: text('name').notNull(),
  avatar: text('avatar'),
  image: text('image'), // Better-Auth canonical field; we keep `avatar` too for back-compat
  baseCurrencyId: uuid('base_currency_id').references(() => tokens.id, {
    onDelete: 'restrict',
  }), // Reference to a fiat token
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Better-Auth session + account + verification tables.
export const userSessions = pgTable('user_sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userAccounts = pgTable('user_accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userVerifications = pgTable('user_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Institutions table - Public, available to all users
export const institutions = pgTable(
  'institutions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => institutionTypes.id, { onDelete: 'restrict' }), // Reference to institution_types
    description: text('description'),
    website: text('website'),
    logoUrl: text('logo_url'),
    hasIntegration: boolean('has_integration').notNull().default(false), // Indicates if institution has API integration support
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for institution name globally
    uniqueInstitutionWebsite: unique().on(table.website),
    // Performance index for institution name lookups
    nameIdx: index('idx_institutions_name').on(table.name),
  })
);

// =============================================================================
// TokenMetadata — provider-namespaced jsonb shape on tokens.providerMetadata
// =============================================================================
//
// Each `@scani/providers` provider class that touches identity tags its own
// namespace key here. First-writer-wins per namespace; conflicts logged.
// New providers extend the shape under their own key without colliding.
//
// Lives in this file rather than @scani/providers so the Drizzle column
// can attach the type via `$type<TokenMetadata>()` — making `Token.providerMetadata`
// strongly-typed at every read site without a domain-layer wrapper interface.
export interface TokenMetadata {
  /** CoinGecko: id is the slug used by /coins/{id}/* endpoints. */
  coingecko?: { id: string; symbol?: string };
  /** DeFiLlama coin spec: "ethereum:0xA0b..." or "coingecko:bitcoin". */
  defillama?: { coin: string };
  /** EVM contract identity (uniquely identifies an ERC-20). */
  etherscan?: { chainId: number; contractAddress: string };
  /** Kraken raw asset code as returned by the API: 'XXBT', 'XETH', 'BABY'. */
  kraken?: { asset: string };
  /** Finnhub stock symbol; exchange may differ from marketSegment column. */
  finnhub?: { symbol: string; exchange?: string };
  /** Open for future providers — index signature reserves the namespace shape. */
  [key: string]: unknown;
}

// Tokens table (represents tradeable assets).
//
// Migration 0055 changes:
//   - `provider_metadata` switched from text to jsonb, typed via $type<>()
//   - new `market_segment` column for AAPL US vs AAPL.L disambiguation
//   - replaced (symbol, typeId) unique with a 3-tuple including segment
//   - added partial jsonb index for EVM contract lookups
export const tokens = pgTable(
  'tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => tokenTypes.id, { onDelete: 'restrict' }),
    decimals: real('decimals').notNull().default(2),
    /**
     * Structural property of the security itself, NOT a provider-specific
     * field. Examples: 'US' (NYSE/NASDAQ), 'L' (LSE), 'TO' (Toronto). NULL
     * for crypto and fiat — they have no market segmentation. Lookups,
     * dedup, and indexes use this column directly so consumers don't need
     * to inspect provider metadata to disambiguate cross-listed equities.
     */
    marketSegment: text('market_segment'),
    iconUrl: text('icon_url'),
    /**
     * jsonb after migration 0055. Drizzle's `$type<>()` accepts both the
     * strongly-typed `TokenMetadata` shape (new code) and a JSON-encoded
     * string (legacy `@scani/integrations` and `@scani/pricing-providers`
     * call sites that haven't been ported yet). The string-acceptance is
     * a transitional shim — once the legacy packages are deleted in the
     * final cleanup of this rewrite, the union collapses back to
     * `TokenMetadata` alone.
     *
     * Reads need a one-line cast (`token.providerMetadata as TokenMetadata`)
     * during the transition; new domain code that already does the cast
     * is forward-compatible with the eventual narrowing.
     */
    providerMetadata: jsonb('provider_metadata')
      .$type<TokenMetadata | string>()
      .notNull()
      .default({}),
    isScamProbability: real('is_scam_probability').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Performance indexes — kept identical to pre-0055.
    symbolIdx: index('idx_tokens_symbol').on(table.symbol),
    typeIdIdx: index('idx_tokens_type_id').on(table.typeId),
    // Note: the 3-tuple unique constraint and EVM contract jsonb index
    // are created in migration 0055 directly — Drizzle's `unique()` /
    // `index()` builders can't express `COALESCE(...)` or expression
    // indexes over jsonb paths. Drizzle's introspection won't see them
    // but the database enforces them.
  })
);
// Token / NewToken type exports live with the rest of the type aliases
// at the bottom of this file (see further down).

// Accounts table - User-specific
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => accountTypes.id, { onDelete: 'restrict' }), // Reference to account_types
    description: text('description'),
    metadata: jsonb('metadata').notNull().default('{}'), // Store wallet addresses and chain-specific data
    isHidden: boolean('is_hidden').notNull().default(false), // Hidden accounts excluded from UI but still synced
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for account name per user per institution
    uniqueUserInstitutionAccountName: unique().on(table.userId, table.institutionId, table.name),
    // Performance indexes for account queries
    userIdIdx: index('idx_accounts_user_id').on(table.userId),
    institutionIdIdx: index('idx_accounts_institution_id').on(table.institutionId),
    // Composite index for dashboard queries
    userInstitutionIdx: index('idx_accounts_user_institution').on(
      table.userId,
      table.institutionId
    ),
  })
);

// Holdings table (token balances in accounts) - User-specific for consistency
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
    isHidden: boolean('is_hidden').notNull().default(false), // Hidden holdings are excluded from queries but updated by cron
    isActive: boolean('is_active').notNull().default(true), // Inactive holdings are visible but excluded from total calculations
    lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Performance indexes for frequently queried fields
    userIdIdx: index('idx_holdings_user_id').on(table.userId),
    accountIdIdx: index('idx_holdings_account_id').on(table.accountId),
    tokenIdIdx: index('idx_holdings_token_id').on(table.tokenId),
    // Composite indexes for dashboard queries
    userAccountTokenIdx: index('idx_holdings_user_account_token').on(
      table.userId,
      table.accountId,
      table.tokenId
    ),
    userTokenIdx: index('idx_holdings_user_token').on(table.userId, table.tokenId),
    // Index for filtering hidden holdings
    isHiddenIdx: index('idx_holdings_is_hidden').on(table.isHidden),
    // Index for filtering active holdings in calculations
    isActiveIdx: index('idx_holdings_is_active').on(table.isActive),
    // Index for sync matching: (account_id, token_id, external_id)
    accountTokenExternalIdx: index('idx_holdings_account_token_external').on(
      table.accountId,
      table.tokenId,
      table.externalId
    ),
  })
);

// Token prices table (historical prices)
export const tokenPrices = pgTable(
  'token_prices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'cascade' }),
    baseTokenId: uuid('base_token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }), // Prevent base token deletion
    price: text('price').notNull(), // Store as string for Decimal.js precision
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    source: text('source'),
    // 'daily' = backfilled daily close | 'intraday' = live sync | 'tx-exact' = at trade ts.
    // Migration 0053 adds this column; default 'intraday' preserves existing rows.
    granularity: text('granularity').notNull().default('intraday'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint keyed on (token, base, timestamp, granularity).
    // Migration 0053 widens the pre-existing 3-column key to include
    // granularity so daily-backfill rows and intraday live rows at the
    // same timestamp don't collide.
    uniqueTokenPriceTimestamp: unique('token_prices_token_base_ts_gran_unique').on(
      table.tokenId,
      table.baseTokenId,
      table.timestamp,
      table.granularity
    ),
    // Performance indexes for price lookups
    pricesLookupIdx: index('idx_token_prices_lookup').on(
      table.tokenId,
      table.baseTokenId,
      table.timestamp.desc()
    ),
    timestampIdx: index('idx_token_prices_timestamp').on(table.timestamp.desc()),
    granularityLookupIdx: index('idx_token_prices_granularity_lookup').on(
      table.tokenId,
      table.baseTokenId,
      table.granularity,
      table.timestamp.desc()
    ),
  })
);

// =============================================================================
// HISTORICAL PNL — ledger, observations, coverage, rollup cache (migration 0053)
// =============================================================================

// The authoritative ledger of every economic event we ingest from any source:
// chain tx, CEX trade, statement line, screenshot extraction, manual entry,
// plus synthesized 'opening_balance' rows from reconciliation.
// Never overrides holdings.balance — strictly additive.
export const holdingTransactions = pgTable(
  'holding_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Primary relational anchor — the position this event belongs to.
    // `holdings.id` fans out to the account + token via JOIN and
    // keeps the ledger compatible with multi-lot / multi-holding-per-
    // (account, token) scenarios (tax lots, staking splits, etc.).
    // Migration 0054 dropped the old account_id column in favor of
    // this key; use `holdings.accountId` for per-account aggregation.
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' }),
    // Same as holdings.tokenId, kept denormalized for query ergonomics:
    // the row also carries counterTokenId + feeTokenId, so having a
    // single tokenId column alongside keeps "show all BTC trades"
    // queries from needing a holdings JOIN. Ingesters MUST keep this
    // in sync with the referenced holding's token.
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
    priceNativeTokenId: uuid('price_native_token_id').references(() => tokens.id),
    // For trades / swaps: the other side of the transaction.
    counterTokenId: uuid('counter_token_id').references(() => tokens.id),
    counterQuantity: text('counter_quantity'),
    counterPriceNative: text('counter_price_native'),
    counterPriceNativeTokenId: uuid('counter_price_native_token_id').references(() => tokens.id),
    // Fees in their native token.
    feeQuantity: text('fee_quantity'),
    feeTokenId: uuid('fee_token_id').references(() => tokens.id),
    // When the tx actually happened per the source (not our ingest time).
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    // Chain tx hash / exchange trade id / bank tx id — for dedup across
    // re-ingests. NOT NULL so the unique constraint on
    // (holding_id, source, external_id) is meaningful: Postgres treats
    // nullable columns as distinct in uniqueness, which would allow
    // unbounded duplicates on re-ingest. Every ingester must synthesize
    // a stable id when the source doesn't provide one.
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

// Append-only point-in-time balance truth. Used as anchors to derive balance
// at any past time. Sources: 'sync-capture' (every live sync appends one),
// 'statement-close' (closing balance from an uploaded statement),
// 'screenshot' (extracted via AI vision), 'user-entered', 'manual-correction'.
export const holdingBalanceObservations = pgTable(
  'holding_balance_observations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Positions this observation describes. account_id + token_id
    // removed in migration 0054 — they're derivable from holdings.
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
  // Names of ingester sources that have contributed — e.g. ['etherscan', 'binance-api'].
  txSources: text('tx_sources').array().notNull().default(sql`'{}'`),
  hasCompleteTxHistory: boolean('has_complete_tx_history').notNull().default(false),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  // The synthesized opening balance (positive or negative Decimal.js string),
  // or null if reconciliation has not yet run or sum(txs) matched observation.
  openingBalanceQuantity: text('opening_balance_quantity'),
  reconciliationNotes: text('reconciliation_notes'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Derived daily rollup cache. Rebuildable from holding_transactions +
// holding_balance_observations + token_prices. Keyed by (user, date, base)
// so switching display currency doesn't invalidate other users' caches.
export const portfolioValueDaily = pgTable(
  'portfolio_value_daily',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    snapshotDate: date('snapshot_date').notNull(),
    baseCurrencyId: uuid('base_currency_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }),
    totalValue: text('total_value').notNull(),
    coverageQuality: text('coverage_quality').notNull(),
    holdingsWithKnownValue: integer('holdings_with_known_value').notNull(),
    holdingsTotal: integer('holdings_total').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.userId, table.snapshotDate, table.baseCurrencyId],
    }),
    userDateIdx: index('idx_portfolio_value_daily_user_date').on(
      table.userId,
      table.snapshotDate.desc()
    ),
  })
);

// User wallets table - Maps user wallets to multiple networks/institutions
export const userWallets = pgTable(
  'user_wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }), // Reference to Scani user
    walletAddress: text('wallet_address').notNull(), // Blockchain wallet address
    institutionIds: jsonb('institution_ids').notNull().default('[]'), // Array of institution IDs (networks) this wallet exists on
    label: text('label'), // Optional user-friendly label
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for wallet address per user
    uniqueUserWalletAddress: unique().on(table.userId, table.walletAddress),
    // Index for fast lookups by user ID
    userIdIdx: index('idx_user_wallets_user_id').on(table.userId),
    // Index for wallet address lookups
    walletAddressIdx: index('idx_user_wallets_wallet_address').on(table.walletAddress),
  })
);

// User integration credentials table - Stores encrypted OAuth tokens, API keys, etc.
export const userIntegrationCredentials = pgTable(
  'user_integration_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }), // Reference to Scani user
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }), // Reference to institution
    encryptedCredentials: jsonb('encrypted_credentials').notNull(), // Encrypted OAuth tokens, API keys, etc.
    credentialsType: text('credentials_type').notNull(), // 'oauth', 'api_key', 'rpc', etc.
    isActive: boolean('is_active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }), // For OAuth tokens with expiration
    // Orphan-reconciliation tracking. See migration 0046. `pending_enqueue` =
    // DB row committed but the BullMQ enqueue hasn't acknowledged; the
    // reconciler job in apps/worker/src/schedulers/ picks up stale rows.
    importStatus: credentialsImportStatusEnum('import_status').notNull().default('enqueued'),
    importJobId: text('import_job_id'),
    importEnqueuedAt: timestamp('import_enqueued_at', { withTimezone: true }),
    importLastError: text('import_last_error'),
    importRetryCount: integer('import_retry_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for one credential set per user per institution
    uniqueUserInstitution: unique().on(table.userId, table.institutionId),
    // Index for fast lookups by user ID
    userIdIdx: index('idx_user_integration_credentials_user_id').on(table.userId),
    // Index for institution lookups
    institutionIdIdx: index('idx_user_integration_credentials_institution_id').on(
      table.institutionId
    ),
    // Composite index for user+institution queries
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
    // Note: the partial LRU index used by the selector is created in the
    // migration directly (Drizzle's index() doesn't support WHERE).
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

// Durable mirror of user-initiated BullMQ jobs (see migration 0047). BullMQ
// evicts completed/failed jobs past retention (removeOnComplete/removeOnFail),
// so the "/jobs" UI reads from here for historical listings and falls back to
// here for `jobs.status` when Redis no longer has the job. The backend's
// enqueue helper inserts a row before calling `queue.add`; the worker's
// processor-wrapper updates state+progress+result on every lifecycle event.
export const userJobs = pgTable(
  'user_jobs',
  {
    jobId: text('job_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobName: text('job_name').notNull(),
    state: userJobStateEnum('state').notNull().default('queued'),
    progress: real('progress').notNull().default(0),
    result: jsonb('result'),
    error: text('error'),
    attemptsMade: integer('attempts_made').notNull().default(0),
    attemptsAllowed: integer('attempts_allowed').notNull().default(1),
    payloadSummary: jsonb('payload_summary').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // For jobs whose result requires a follow-up user action (review +
    // confirm of extracted holdings from a screenshot/PDF/CSV), this
    // stamps the one-shot moment the user acted on it. Re-visits after
    // this is set render the result read-only so the same extracted
    // holdings can't be imported twice. Null for informative-only jobs.
    actionTakenAt: timestamp('action_taken_at', { withTimezone: true }),
  },
  (table) => ({
    userCreatedIdx: index('idx_user_jobs_user_created').on(table.userId, table.createdAt),
    userStateCreatedIdx: index('idx_user_jobs_user_state_created').on(
      table.userId,
      table.state,
      table.createdAt
    ),
  })
);

// Institution blockchain chain mappings table - Maps institutions to blockchain chain IDs
export const institutionBlockchainMappings = pgTable(
  'institution_blockchain_mappings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' })
      .unique(), // Each institution can only map to one chain
    chainId: text('chain_id').notNull(), // Blockchain chain ID (e.g., '1' for Ethereum, 'bitcoin', 'solana')
    chainType: text('chain_type').notNull(), // 'evm', 'bitcoin', 'solana', 'tron', 'ton'
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Index for fast lookups by institution ID
    institutionIdIdx: index('idx_institution_blockchain_mappings_institution_id').on(
      table.institutionId
    ),
    // Index for chain ID lookups
    chainIdIdx: index('idx_institution_blockchain_mappings_chain_id').on(table.chainId),
  })
);

// Groups table - User-defined custom groups for organizing holdings
// Groups table - User-defined custom groups for organizing holdings
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(), // Hex color code (e.g., '#3b82f6')
    description: text('description'),
    displayOrder: real('display_order').notNull().default(0), // For custom ordering
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for group name per user
    uniqueUserGroupName: unique().on(table.userId, table.name),
    // Performance index for user queries
    userIdIdx: index('idx_groups_user_id').on(table.userId),
    // Index for ordering
    displayOrderIdx: index('idx_groups_display_order').on(table.userId, table.displayOrder),
  })
);

// Holding groups junction table - Many-to-many relationship between holdings and groups
export const holdingGroups = pgTable(
  'holding_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint to prevent duplicate assignments
    uniqueHoldingGroup: unique().on(table.holdingId, table.groupId),
    // Performance indexes for lookups
    holdingIdIdx: index('idx_holding_groups_holding_id').on(table.holdingId),
    groupIdIdx: index('idx_holding_groups_group_id').on(table.groupId),
  })
);

// Account groups junction table - Many-to-many relationship between accounts and groups
export const accountGroups = pgTable(
  'account_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint to prevent duplicate assignments
    uniqueAccountGroup: unique().on(table.accountId, table.groupId),
    // Performance indexes for lookups
    accountIdIdx: index('idx_account_groups_account_id').on(table.accountId),
    groupIdIdx: index('idx_account_groups_group_id').on(table.groupId),
  })
);

// Vaults table - User-defined savings goals with target amounts
export const vaults = pgTable(
  'vaults',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    targetAmount: text('target_amount').notNull(), // Store as string for Decimal.js precision
    currencyId: uuid('currency_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }), // Vault's target currency
    currentAmount: text('current_amount').notNull().default('0'), // Pre-computed sum of attributed values
    color: text('color').notNull(), // Hex color code (e.g., '#3b82f6')
    iconName: text('icon_name'), // Optional icon identifier for UI
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for vault name per user
    uniqueUserVaultName: unique().on(table.userId, table.name),
    // Performance index for user queries
    userIdIdx: index('idx_vaults_user_id').on(table.userId),
    // Composite index for active vaults by user
    userActiveIdx: index('idx_vaults_user_active').on(table.userId, table.isActive),
  })
);

// Vault holdings junction table - Links holdings to vaults with a percentage
export const vaultHoldings = pgTable(
  'vault_holdings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' }),
    percentage: real('percentage').notNull(), // 1-100, fraction of holding attributed to this vault
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint to prevent duplicate vault-holding assignments
    uniqueVaultHolding: unique().on(table.vaultId, table.holdingId),
    // Performance indexes for lookups
    vaultIdIdx: index('idx_vault_holdings_vault_id').on(table.vaultId),
    holdingIdIdx: index('idx_vault_holdings_holding_id').on(table.holdingId),
  })
);

// Holding APY configs table - Per-holding interest/yield configuration
export const holdingApyConfigs = pgTable(
  'holding_apy_configs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' })
      .unique(), // One APY config per holding
    annualRatePct: text('annual_rate_pct').notNull(), // Decimal string, e.g. "4.5" for 4.5%
    payoutFrequency: text('payout_frequency').notNull(), // 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
    payoutDayOfWeek: real('payout_day_of_week'), // 0=Sun..6=Sat, for 'weekly'
    payoutDayOfMonth: real('payout_day_of_month'), // 1-31, for 'monthly' and 'yearly'
    payoutMonth: real('payout_month'), // 1-12, for 'yearly'
    lastPayoutAt: timestamp('last_payout_at', { withTimezone: true }), // Tracks last successful payout
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    holdingIdIdx: index('idx_holding_apy_configs_holding_id').on(table.holdingId),
    activeIdx: index('idx_holding_apy_configs_active').on(table.isActive),
  })
);

// Admin audit log: records operator-initiated mutations (e.g. BullMQ
// retry/remove from the admin dashboard). See migration 0045.
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    result: text('result').notNull(),
    details: jsonb('details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdAtIdx: index('admin_audit_log_created_at_idx').on(table.createdAt),
  })
);

// Append-only log of manual price edits on custom tokens (types
// 'private-company' and 'other'). `previousPrice` is null on the creation
// entry. Unlocks future abuse-detection / user-flagging without schema
// changes. See migration 0052.
export const tokenPriceEditHistory = pgTable(
  'token_price_edit_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'cascade' }),
    baseTokenId: uuid('base_token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }),
    previousPrice: text('previous_price'),
    newPrice: text('new_price').notNull(),
    editedByUserId: uuid('edited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenCreatedIdx: index('idx_token_price_edit_history_token_created').on(
      table.tokenId,
      table.createdAt.desc()
    ),
    userCreatedIdx: index('idx_token_price_edit_history_user_created').on(
      table.editedByUserId,
      table.createdAt.desc()
    ),
  })
);

// =============================================================================
// RELATIONS
// =============================================================================

// Relations
export const institutionTypesRelations = relations(institutionTypes, ({ many }) => ({
  institutions: many(institutions),
}));

export const accountTypesRelations = relations(accountTypes, ({ many }) => ({
  accounts: many(accounts),
}));

export const tokenTypesRelations = relations(tokenTypes, ({ many }) => ({
  tokens: many(tokens),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  accounts: many(accounts),
  holdings: many(holdings),
  userWallets: many(userWallets),
  userIntegrationCredentials: many(userIntegrationCredentials),
  groups: many(groups),
  vaults: many(vaults),
  baseCurrency: one(tokens, {
    fields: [users.baseCurrencyId],
    references: [tokens.id],
  }),
}));

export const institutionsRelations = relations(institutions, ({ one, many }) => ({
  type: one(institutionTypes, {
    fields: [institutions.typeId],
    references: [institutionTypes.id],
  }),
  accounts: many(accounts),
  blockchainMapping: one(institutionBlockchainMappings, {
    fields: [institutions.id],
    references: [institutionBlockchainMappings.institutionId],
  }),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
  institution: one(institutions, {
    fields: [accounts.institutionId],
    references: [institutions.id],
  }),
  type: one(accountTypes, {
    fields: [accounts.typeId],
    references: [accountTypes.id],
  }),
  holdings: many(holdings),
  accountGroups: many(accountGroups),
}));

export const tokensRelations = relations(tokens, ({ one, many }) => ({
  type: one(tokenTypes, {
    fields: [tokens.typeId],
    references: [tokenTypes.id],
  }),
  holdings: many(holdings),
  prices: many(tokenPrices),
  basePrices: many(tokenPrices, {
    relationName: 'basePrices',
  }),
}));

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

export const tokenPricesRelations = relations(tokenPrices, ({ one }) => ({
  token: one(tokens, {
    fields: [tokenPrices.tokenId],
    references: [tokens.id],
  }),
  baseToken: one(tokens, {
    fields: [tokenPrices.baseTokenId],
    references: [tokens.id],
    relationName: 'basePrices',
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

export const portfolioValueDailyRelations = relations(portfolioValueDaily, ({ one }) => ({
  user: one(users, {
    fields: [portfolioValueDaily.userId],
    references: [users.id],
  }),
  baseCurrency: one(tokens, {
    fields: [portfolioValueDaily.baseCurrencyId],
    references: [tokens.id],
  }),
}));

export const userWalletsRelations = relations(userWallets, ({ one }) => ({
  user: one(users, {
    fields: [userWallets.userId],
    references: [users.id],
  }),
}));

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

export const institutionBlockchainMappingsRelations = relations(
  institutionBlockchainMappings,
  ({ one }) => ({
    institution: one(institutions, {
      fields: [institutionBlockchainMappings.institutionId],
      references: [institutions.id],
    }),
  })
);

export const groupsRelations = relations(groups, ({ one, many }) => ({
  user: one(users, {
    fields: [groups.userId],
    references: [users.id],
  }),
  holdingGroups: many(holdingGroups),
  accountGroups: many(accountGroups),
}));

export const holdingGroupsRelations = relations(holdingGroups, ({ one }) => ({
  holding: one(holdings, {
    fields: [holdingGroups.holdingId],
    references: [holdings.id],
  }),
  group: one(groups, {
    fields: [holdingGroups.groupId],
    references: [groups.id],
  }),
}));

export const accountGroupsRelations = relations(accountGroups, ({ one }) => ({
  account: one(accounts, {
    fields: [accountGroups.accountId],
    references: [accounts.id],
  }),
  group: one(groups, {
    fields: [accountGroups.groupId],
    references: [groups.id],
  }),
}));

export const vaultsRelations = relations(vaults, ({ one, many }) => ({
  user: one(users, {
    fields: [vaults.userId],
    references: [users.id],
  }),
  currency: one(tokens, {
    fields: [vaults.currencyId],
    references: [tokens.id],
  }),
  vaultHoldings: many(vaultHoldings),
}));

export const vaultHoldingsRelations = relations(vaultHoldings, ({ one }) => ({
  vault: one(vaults, {
    fields: [vaultHoldings.vaultId],
    references: [vaults.id],
  }),
  holding: one(holdings, {
    fields: [vaultHoldings.holdingId],
    references: [holdings.id],
  }),
}));

export const holdingApyConfigsRelations = relations(holdingApyConfigs, ({ one }) => ({
  holding: one(holdings, {
    fields: [holdingApyConfigs.holdingId],
    references: [holdings.id],
  }),
}));

// Export types for use in application
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type InstitutionType = typeof institutionTypes.$inferSelect;

export type AccountType = typeof accountTypes.$inferSelect;

export type TokenType = typeof tokenTypes.$inferSelect;

export type Institution = typeof institutions.$inferSelect;
export type NewInstitution = typeof institutions.$inferInsert;

export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type Holding = typeof holdings.$inferSelect;
export type NewHolding = typeof holdings.$inferInsert;

export type TokenPrice = typeof tokenPrices.$inferSelect;
export type NewTokenPrice = typeof tokenPrices.$inferInsert;

export type UserWallet = typeof userWallets.$inferSelect;
export type NewUserWallet = typeof userWallets.$inferInsert;

export type UserIntegrationCredentials = typeof userIntegrationCredentials.$inferSelect;
export type NewUserIntegrationCredentials = typeof userIntegrationCredentials.$inferInsert;

export type UserJob = typeof userJobs.$inferSelect;
export type NewUserJob = typeof userJobs.$inferInsert;
export type UserJobState = UserJob['state'];

export type InstitutionBlockchainMapping = typeof institutionBlockchainMappings.$inferSelect;
export type NewInstitutionBlockchainMapping = typeof institutionBlockchainMappings.$inferInsert;

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;

export type HoldingGroup = typeof holdingGroups.$inferSelect;
export type NewHoldingGroup = typeof holdingGroups.$inferInsert;

export type AccountGroup = typeof accountGroups.$inferSelect;
export type NewAccountGroup = typeof accountGroups.$inferInsert;

export type Vault = typeof vaults.$inferSelect;
export type NewVault = typeof vaults.$inferInsert;

export type VaultHolding = typeof vaultHoldings.$inferSelect;
export type NewVaultHolding = typeof vaultHoldings.$inferInsert;

export type HoldingApyConfig = typeof holdingApyConfigs.$inferSelect;
export type NewHoldingApyConfig = typeof holdingApyConfigs.$inferInsert;

export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLog.$inferInsert;

export type TokenPriceEditHistory = typeof tokenPriceEditHistory.$inferSelect;
export type NewTokenPriceEditHistory = typeof tokenPriceEditHistory.$inferInsert;

export type HoldingTransaction = typeof holdingTransactions.$inferSelect;
export type NewHoldingTransaction = typeof holdingTransactions.$inferInsert;

export type HoldingBalanceObservation = typeof holdingBalanceObservations.$inferSelect;
export type NewHoldingBalanceObservation = typeof holdingBalanceObservations.$inferInsert;

export type HoldingCoverage = typeof holdingCoverage.$inferSelect;
export type NewHoldingCoverage = typeof holdingCoverage.$inferInsert;

export type PortfolioValueDaily = typeof portfolioValueDaily.$inferSelect;
export type NewPortfolioValueDaily = typeof portfolioValueDaily.$inferInsert;

// Valid values for holding_transactions.kind. Broader than a pgEnum on purpose —
// new ingesters may introduce new kinds (e.g. 'rebase', 'slash') without
// requiring a schema migration. Readers should tolerate unknown kinds.
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

// Coverage quality bucket on portfolio_value_daily — drives chart rendering
// (solid line / dashed / gap) and informs the data-quality panel.
export type CoverageQuality = 'full' | 'partial' | 'estimated' | 'unknown';

// Granularity on token_prices. 'intraday' is the existing default (live syncs);
// 'daily' is backfilled closes; 'tx-exact' is the price at a tx's occurred_at.
export type TokenPriceGranularity = 'intraday' | 'daily' | 'tx-exact';

// =============================================================================
// CLOUD (data-provider service) — Better-Auth user store + API key registry
// + append-only per-request usage log. Tables are prefixed `cloud_` so they
// live alongside the backend's own auth tables in the same Postgres DB
// without collision. OSS Tier 1 never populates these; Tier 2/3 swaps the
// env-based bearer check for a DB lookup against cloud_api_keys.
// Migrations: 0050_cloud_api_keys.sql
// =============================================================================

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
// third-party meter SaaS). `subject` is the billable id (e.g. cloud_users.id).
// Migration: 0051_cloud_usage_events.sql

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
