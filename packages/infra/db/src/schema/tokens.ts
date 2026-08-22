import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
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

/**
 * Where a `tokens.decimals` came from. Two authorities and no third (SC-544).
 *
 * `chain` — the asset's own chain answered: `decimals()` on the authoritative
 * EVM contract, the mint's `getTokenSupply`, or the chain's native decimals.
 * Which identity on a multi-namespace row is allowed to answer is
 * `identityAuthority()` in `./token-identity-authority`, not a rule
 * restated here.
 *
 * `iso4217` — a currency's minor unit, which is defined rather than observed.
 *
 * `protocol` — an L1 native asset whose smallest unit is fixed by its own
 * protocol and deployed in no contract: ADA's lovelace, DOT's Planck, XRP's
 * drop. The same KIND of authority as `iso4217` rather than a weaker one, and
 * only for the entries in `PROTOCOL_NATIVE_DECIMALS`, each of which carries the
 * command that establishes it.
 *
 * `user` — a custom token its owner created. There is no chain and no standard
 * for one, so its owner is the only authority there can be; refusing their
 * value would leave the one asset class where the answer is knowable
 * permanently NULL.
 *
 * Anything else writes NULL, and an absent answer is never a default. Every
 * wrong row in production came from a writer that had no source and supplied a
 * number anyway — `typeCode === 'crypto' ? 18 : 2` and a zod `.default(2)` are
 * the same expression in different clothes, and both are gone (SC-544).
 */
export type DecimalsSource = 'chain' | 'iso4217' | 'protocol' | 'user';

/** A decimals and the authority that produced it, or neither. */
export interface DecimalsAttribution {
  readonly decimals: number | null;
  readonly decimalsSource: DecimalsSource | null;
}

/**
 * Pair a decimals with its authority, dropping both when the authority did not
 * actually answer.
 *
 * Callers pass this rather than setting the two columns separately, so a value
 * cannot be written without saying where it came from — which is the only
 * structural difference between this column and the one that produced SC-544.
 * An `undefined` from an upstream that had no opinion becomes NULL here rather
 * than a default, and a non-integer or negative answer is not an answer.
 */
export function attributeDecimals(
  decimals: number | null | undefined,
  source: DecimalsSource
): DecimalsAttribution {
  return typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0
    ? { decimals, decimalsSource: source }
    : { decimals: null, decimalsSource: null };
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
    /**
     * The exponent that turns this asset's smallest indivisible unit into one
     * whole unit — the `decimals` in `raw / 10^decimals`. A property of the
     * ASSET, and deliberately NOT a display precision: how many decimals to
     * SHOW is asked of the figure, in `@scani/shared`'s `precision.ts`, which
     * exists because a fixed precision constant caused SC-172/174/177/179.
     * Nothing here may feed a rendering path (SC-544).
     *
     * NULL means no authority answered, and that is a first-class state rather
     * than a gap. It was `real notNull default 2` until SC-544, and the default
     * is what made a guess indistinguishable from a fact: 20 of 251 production
     * rows carried a number no source had ever produced. `integer` because it
     * is a count of digits — `decimals()` returns a uint8.
     *
     * NULL is the CORRECT answer for an equity, not a cautious one: an equity
     * has no on-chain integer, so the field does not apply to the asset class.
     * A `2` there would encode a broker display convention into a field that
     * means on-chain scaling, and IBKR reports fractional shares anyway.
     */
    decimals: integer('decimals'),
    /**
     * Which authority produced `decimals`, so a value we derived is
     * distinguishable from one we inherited. NULL alongside a non-null
     * `decimals` means a legacy row nobody has re-derived.
     *
     * There is no `coingecko` here on purpose. Its `decimal_place` is keyed
     * per DEPLOYMENT rather than per asset — measured 2026-08-22, `starknet`
     * answers 18/18/9 across ethereum/starknet/solana, and `cardano`,
     * `polkadot`, `ripple` and `bitcoin` answer nothing at all — so an
     * aggregator cannot be an authority for a single-valued column.
     */
    decimalsSource: text('decimals_source').$type<DecimalsSource>(),
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
    // Which version of `calculateScamProbability` produced the score above.
    // NULL = scored before versioning existed, which is stale by definition
    // rather than version 0. See migration 0040 (SC-286).
    scamScoreVersion: integer('scam_score_version'),
    // `unscored` = the function never ran, which is every non-crypto token —
    // their 0 is the absence of a verdict, not a stale one. `heuristic` =
    // produced by `calculateScamProbability` and recomputable. `user` = an
    // explicit verdict from markAsScam/unmarkAsScam, never overwritten.
    // Defaults to `unscored` so a new non-crypto row is right by default
    // (SC-286).
    scamScoreSource: text('scam_score_source').notNull().default('unscored'),
    /**
     * Set when this token's SYMBOL is drawn from lookalike characters —
     * the value is the ASCII symbol it presents as, so `UЅDС` (Cyrillic
     * Ѕ and С) carries `USDC`. Null means the symbol is plain ASCII and
     * reads as itself.
     *
     * Its own column rather than a band of `is_scam_probability`, and
     * that separation is the point. A homoglyph scores 1.00 when we hold
     * no price for it and 0.70 once we do — the 0.30 difference is
     * "no pricing data available", a fact about OUR coverage that the
     * token has no part in. `WarmTokenPricesForImportUseCase` then
     * re-scores priced tokens downward, so a row quarantined at 1.00
     * later reads as ordinary. This column is written once from the
     * characters themselves and nothing re-scores it (SC-197).
     */
    lookalikeOf: text('lookalike_of'),
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
