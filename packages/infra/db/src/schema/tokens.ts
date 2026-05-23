import { relations } from 'drizzle-orm';
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
import { holdings } from './holdings';
import { users } from './users';

// =============================================================================
// TokenMetadata — provider-namespaced jsonb shape on tokens.providerMetadata
// =============================================================================
//
// Each `@scani/providers` provider class that touches identity tags its own
// namespace key here. First-writer-wins per namespace; conflicts logged.
// New providers extend the shape under their own key without colliding.
//
// Lives in this file rather than @scani/providers so the Drizzle column can
// attach the type via `$type<TokenMetadata>()` — making
// `Token.providerMetadata` strongly-typed at every read site without a
// domain-layer wrapper interface.
export interface TokenMetadata {
  /** CoinGecko: id is the slug used by /coins/{id}/* endpoints. */
  coingecko?: { id: string; symbol?: string };
  /** DeFiLlama coin spec: "ethereum:0xA0b..." or "coingecko:bitcoin". */
  defillama?: { coin: string };
  /**
   * EVM contract identity — `chainId` alone identifies a native asset
   * (ETH on Ethereum, MATIC on Polygon, etc.); pair it with
   * `contractAddress` for ERC-20s.
   */
  etherscan?: { chainId: number; contractAddress?: string };
  /**
   * Solana SPL token identity — the mint address. Native SOL has no
   * mint; SPL tokens always do. Used by the Helius-driven balance/tx
   * provider and consumed by DeFiLlama (`solana:<mint>` query key)
   * for both current and historical prices.
   */
  solana?: { mint: string };
  /** Kraken raw asset code as returned by the API: 'XXBT', 'XETH', 'BABY'. */
  kraken?: { asset: string };
  /** Finnhub stock symbol; exchange may differ from marketSegment column. */
  finnhub?: { symbol: string; exchange?: string };
  /** Open for future providers — index signature reserves the namespace shape. */
  [key: string]: unknown;
}

// Dynamic enum table for token types — 'fiat', 'crypto', 'public-stock',
// 'private-company', 'other'. Admin-extensible without a migration.
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

// Tradeable assets (fiat / crypto / equities / private). Migration 0055
// changes:
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
     * jsonb after migration 0055. Drizzle's `$type<>()` accepts both
     * the strongly-typed `TokenMetadata` object and a JSON-encoded
     * string for older rows that haven't been re-serialized. Reads
     * need a one-line cast (`token.providerMetadata as TokenMetadata`)
     * to narrow.
     */
    providerMetadata: jsonb('provider_metadata')
      .$type<TokenMetadata | string>()
      .notNull()
      .default({}),
    isScamProbability: real('is_scam_probability').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    // Cooldown gate consulted by the historical-price backfill: when set
    // and in the future, the backfill skips the token instead of asking
    // providers for prices we've already established they can't supply.
    // Cleared on the next successful price write.
    unpriceableUntil: timestamp('unpriceable_until', { withTimezone: true }),
    lastPricingAttemptAt: timestamp('last_pricing_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    symbolIdx: index('idx_tokens_symbol').on(table.symbol),
    typeIdIdx: index('idx_tokens_type_id').on(table.typeId),
    unpriceableUntilIdx: index('idx_tokens_unpriceable_until').on(table.unpriceableUntil),
    // Note: the 3-tuple unique constraint and EVM contract jsonb index
    // are created in migration 0055 directly — Drizzle's `unique()` /
    // `index()` builders can't express `COALESCE(...)` or expression
    // indexes over jsonb paths. Drizzle's introspection won't see them
    // but the database enforces them.
  })
);

// Historical prices, one row per (token, base, timestamp, granularity).
// Granularity: 'daily' (backfilled close), 'intraday' (live sync),
// 'tx-exact' (price at trade ts).
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
    // Migration 0053 adds this column; default 'intraday' preserves existing rows.
    granularity: text('granularity').notNull().default('intraday'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique key (token, base, timestamp, granularity) — migration 0053
    // widened the pre-existing 3-column key to include granularity so
    // daily-backfill rows and intraday live rows at the same timestamp
    // don't collide.
    uniqueTokenPriceTimestamp: unique('token_prices_token_base_ts_gran_unique').on(
      table.tokenId,
      table.baseTokenId,
      table.timestamp,
      table.granularity
    ),
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

// Append-only log of manual price edits on custom tokens (types
// 'private-company' and 'other'). `previousPrice` is null on the
// creation entry. Unlocks future abuse-detection / user-flagging without
// schema changes. See migration 0052.
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

export const tokenTypesRelations = relations(tokenTypes, ({ many }) => ({
  tokens: many(tokens),
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

export type TokenType = typeof tokenTypes.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;
export type TokenPrice = typeof tokenPrices.$inferSelect;
export type NewTokenPrice = typeof tokenPrices.$inferInsert;
export type TokenPriceEditHistory = typeof tokenPriceEditHistory.$inferSelect;
export type NewTokenPriceEditHistory = typeof tokenPriceEditHistory.$inferInsert;

// Granularity on token_prices. 'intraday' is the existing default (live
// syncs); 'daily' is backfilled closes; 'tx-exact' is the price at a tx's
// occurred_at.
export type TokenPriceGranularity = 'intraday' | 'daily' | 'tx-exact';
