/**
 * Runtime-shape types used by providers. Anything that maps to a DB
 * row (Token, NewToken, TokenMetadata) lives in `@scani/db/schema`
 * — see `packages/infra/db/src/schema.ts`. This file holds only types
 * with no DB counterpart: provider request contexts, responses,
 * and ingestion event shapes.
 */

import type { NewToken, Token } from '@scani/db/schema';

/**
 * Plaintext credentials passed by the caller into a provider's
 * self-credentialed methods. Decryption is owned by
 * `IntegrationCredentialsService`; providers never see the encrypted
 * blob. Any subset of these fields may be populated depending on the
 * integration's auth shape.
 */
export interface DecryptedCredentials {
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  accessToken?: string;
  /** Brokers like IBKR keep auth in a paired token + query id. */
  flexQueryToken?: string;
  flexQueryId?: string;
  /** Open-ended for venues that bring their own auth shape. */
  [key: string]: unknown;
}

/**
 * Per-call context every provider method receives.
 *
 * Credentials NEVER appear here as plaintext. Instead the caller
 * supplies `credentialsRef` + `resolveCredentials`; the provider
 * resolves on demand inside its private hot path. This keeps AES-GCM
 * decryption inside `IntegrationCredentialsService` and means no
 * provider can accidentally leak a credential into a log line.
 *
 * Pool-credentialed methods (current/historical pricing, identity
 * enrichment) treat `credentialsRef` as optional — they self-resolve
 * via `CredentialPool` when the caller has no integration. Self-
 * credentialed methods (balances, transactions, validation) require
 * `credentialsRef` at the type level via `WithUserCreds<T>`.
 */
export interface ProviderContext {
  /** Token to denominate prices in. Always a real Token row. */
  baseCurrency: Token;
  /** Wall-clock timestamp the caller wants prices/balances "as of". */
  timestamp?: Date;
  /** Owning user — used for audit trails on pool borrows. */
  userId?: string;
  /** Owning account — for balance / transaction calls. */
  accountId?: string;
  credentialsRef?: { userId: string; institutionId: string };
  resolveCredentials?: (ref: {
    userId: string;
    institutionId: string;
  }) => Promise<DecryptedCredentials>;
}

/**
 * Compile-time enforcement that a method requires the caller to supply
 * credentials (no pool fallback). Self-credentialed capabilities use
 * `WithUserCreds<ProviderContext>` in their signatures so passing a
 * context without `credentialsRef` is a type error.
 */
export type WithUserCreds<C extends ProviderContext> = C & {
  credentialsRef: NonNullable<C['credentialsRef']>;
  resolveCredentials: NonNullable<C['resolveCredentials']>;
};

/**
 * Single price datapoint. Stored verbatim in `token_prices` by the
 * orchestrator; `source` is `${providerKey}_${variant}` so audit /
 * de-conflict logic can attribute rows to the provider that produced
 * them.
 */
export interface PriceQuote {
  tokenId: string;
  baseTokenId: string;
  /** Decimal.js string — never a JS number to avoid float drift. */
  price: string;
  /** When the quote is "as of" — may differ from request timestamp
      when the provider returns the closest available bar. */
  timestamp: Date;
  source: string;
}

/**
 * One position observed at a point in time. `tokenIdentity` is a
 * partial NewToken that the orchestrator passes through
 * `TokenService.findOrCreateByIdentity` to materialize a real `Token`
 * row before persisting the holding.
 */
export interface HoldingSnapshot {
  /** Provider-native asset id ('BTC', 'XXBT', 'ETH', etc.) — feeds
      the dedup constraint on holdings.externalId. */
  externalId: string;
  tokenIdentity: Partial<NewToken>;
  /** Decimal.js string. */
  balance: string;
  capturedAt: Date;
  /**
   * Token type code — `'crypto'` (default), `'fiat'`, `'stock'`. The
   * orchestrator uses this to pick the correct `tokenTypes` row when
   * creating the underlying `Token` (and to route the holding to the
   * right pricer downstream — fiat goes to Frankfurter, crypto to
   * CoinGecko/DeFiLlama, stock to Finnhub/Yahoo). Providers that mix
   * fiat + crypto in one balance call (Kraken, Coinbase, IBKR) must
   * set this explicitly; pure-crypto providers can omit it.
   */
  tokenType?: string;
}

/**
 * Sub-account discovered under a single integration credential. Brokers
 * (IBKR Flex Query) and venues (Wise multi-currency, Binance spot vs
 * margin) expose multiple accounts behind one set of credentials; the
 * `AccountDiscoveryProvider` capability returns this shape so use
 * cases like `ImportExchangeAccountsUseCase` can iterate.
 */
export interface DiscoveredAccount {
  /** Provider-native id — feeds accounts.externalId for dedup. */
  externalId: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Native fiat / settlement currency, when applicable. */
  nativeCurrency?: string;
  /** Open-ended provider details (sub-account type, market segment,
      etc.). Persisted into accounts.metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Single ledger event from a transactions ingester. Mirrors the shape
 * we persist in `holding_transactions`, but expressed in terms of
 * partial token identities — so the orchestrator can find-or-create
 * the relevant tokens through the same federation flow that handles
 * brand-new wallet imports. `kind` matches the holding_transactions
 * schema enum.
 */
export interface TransactionEvent {
  /** Stable provider-native id (chain tx hash, exchange trade id,
      etc.) — feeds the (holding_id, source, external_id) unique. */
  externalId: string;
  occurredAt: Date;
  kind:
    | 'buy'
    | 'sell'
    | 'deposit'
    | 'withdraw'
    | 'fee'
    | 'reward'
    | 'interest'
    | 'transfer_in'
    | 'transfer_out'
    | 'swap_in'
    | 'swap_out'
    | 'opening_balance'
    | 'unknown';
  /** Primary token + signed quantity. Outflows negative; inflows
      positive. Sign-enforcement happens at the base-class boundary,
      not in concrete providers. */
  primary: { tokenIdentity: Partial<NewToken>; quantity: string };
  /** Other side of a trade or swap. Optional. */
  counter?: { tokenIdentity: Partial<NewToken>; quantity: string };
  /** Fee leg, in its own native token (often distinct from primary). */
  fee?: { tokenIdentity: Partial<NewToken>; quantity: string };
  /** Per-unit price at the time the tx happened, denominated in its
      native quote currency (a Kraken BTC/EUR trade has
      `quoteIdentity` = EUR). Stored as-is so cost basis stays
      currency-correct without round-tripping through USD. */
  priceNative?: { value: string; quoteIdentity: Partial<NewToken> };
  rawPayload?: unknown;
}
