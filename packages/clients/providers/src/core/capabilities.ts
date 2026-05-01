/**
 * Capability interfaces — the contract every provider implements.
 *
 * A single provider class can implement any subset. The
 * `ProviderRegistry` discovers which capabilities a provider satisfies
 * via duck-typed `is*Provider` guards (presence of the key methods),
 * not via interface declaration. This keeps provider classes free to
 * mix and match without ballooning the inheritance graph.
 *
 * The capabilities split into TWO credential regimes:
 *
 *   POOL-CREDENTIALED (ctx.credentialsRef OPTIONAL):
 *     - CurrentPriceProvider, HistoricalPriceProvider — public price
 *       reads, can borrow any user's credential to satisfy.
 *     - TokenIdentityProvider — public symbol/contract lookups, same.
 *     - AIInferenceProvider — system-credentialed only (no user
 *       creds at all), but treated as "ambient" auth.
 *
 *   SELF-CREDENTIALED (ctx.credentialsRef REQUIRED at the type level):
 *     - BalanceProvider, TransactionsProvider — owner-private data.
 *     - CredentialValidator — by definition tests one user's creds.
 *
 * The `WithUserCreds<T>` brand on self-credentialed methods means
 * passing a context without `credentialsRef` is a type error — the
 * compiler refuses to route a pool credential into a balance fetch.
 */

import type { NewToken, Token, TokenMetadata } from '@scani/db/schema';
import type { IntegrationManifest } from './integration-manifest';
import type {
  DecryptedCredentials,
  DiscoveredAccount,
  HoldingSnapshot,
  PriceQuote,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from './types';

export type Capability =
  | 'current-price'
  | 'historical-price'
  | 'current-balances'
  | 'transactions'
  | 'token-identity'
  | 'credential-validator'
  | 'account-discoverer'
  | 'address-validator'
  | 'ai-inference';

/**
 * Marker that every provider class exposes. Lets the registry log
 * what got registered and lets the type-check at runtime cross-
 * reference declared capabilities against actual method presence.
 */
export interface ProviderBase {
  readonly providerKey: string;
  readonly capabilities: readonly Capability[];
  /**
   * Self-describing metadata for the integrations UI. Set on
   * credentialed providers (CEX, brokers, neobanks); omitted on
   * Scani-owned (CoinGecko, OpenAI, …) and on wallet-explorer
   * providers (Etherscan, Bitcoin, …) since those have a different UX.
   */
  readonly manifest?: IntegrationManifest;
}

// ============================================================================
// Pool-credentialed capabilities (ctx.credentialsRef optional)
// ============================================================================

export interface CurrentPriceProvider extends ProviderBase {
  /** Synchronous declarative gate — registry filters providers per
      lookup so a Kraken provider isn't asked about LSE-listed
      equities. */
  canPrice(t: Token): boolean;
  fetchCurrentPrice(t: Token, ctx: ProviderContext): Promise<PriceQuote | null>;
  /** Optional batch hint. CoinGecko's `/simple/price?ids=...` accepts
      hundreds of tokens per call; the orchestrator detects this method
      and prefers it for bulk current-price snapshots. */
  fetchCurrentPrices?(tokens: Token[], ctx: ProviderContext): Promise<Map<string, PriceQuote>>;
}

export interface HistoricalPriceProvider extends CurrentPriceProvider {
  fetchHistoricalPrice(t: Token, at: Date, ctx: ProviderContext): Promise<PriceQuote | null>;
  /** Optional bulk-range fetch. Kraken/Binance OHLC endpoints return
      720 daily bars per call; pricing-providers backfill cron uses
      this when present to collapse N day-by-day calls into one. */
  fetchHistoricalRange?(
    t: Token,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]>;
}

export interface TokenSearchResult {
  /** Display symbol (uppercased), e.g. `AAPL`, `BTC`, `XEQT.TO`. */
  symbol: string;
  /** Human-readable name from the upstream search index. */
  name: string;
  /** Upstream-tagged token type, e.g. `Equity`, `ETF`, `Crypto`. The
      api maps this to its own enum at consumption time. */
  type: string;
  /** ISO currency code the upstream prices the token in (`USD`, `GBP`, …). */
  currency?: string;
  /** Listing exchange code when known (`NASDAQ`, `LSE`, `TSE`, …). */
  exchange?: string;
  /** Which provider produced this result. Lets callers prioritise / dedupe. */
  provider: string;
  /** Free-form upstream metadata stored on the token record at create-time
      so subsequent pricing/identity calls don't have to re-resolve. */
  providerMetadata?: Record<string, unknown>;
}

export interface TokenIdentityProvider extends ProviderBase {
  /**
   * Probe a partial token (in-memory, not yet persisted) → return the
   * subset of `TokenMetadata` this provider can fill in. Returns null
   * when the provider has no opinion. Idempotent: skips if
   * `partial.providerMetadata` already has this provider's namespace
   * key, unless `force` is true (debug-only).
   *
   * Returning only the metadata delta — not a full Token — is
   * deliberate. The caller (`TokenService.findOrCreateByIdentity`)
   * fans out to every registered identity provider in parallel and
   * merges the deltas under their respective namespace keys, so each
   * provider only owns its own metadata namespace and doesn't have to
   * synthesize columns it doesn't know about (symbol, typeId,
   * marketSegment).
   */
  enrichTokenIdentity(
    partial: Partial<NewToken>,
    opts?: { force?: boolean }
  ): Promise<Partial<TokenMetadata> | null>;
  /** Optional: list every token this provider knows about. Drives
      the nightly token-discovery cron when a new provider is added —
      lets us proactively fill in metadata for things we'd otherwise
      only encounter when a user holds them. */
  listSupportedTokens?(): Promise<Partial<NewToken>[]>;
  /** Optional: free-text search against the provider's symbol index.
      Used by the api `tokens.search` flow (manual holding creation,
      token autocomplete) so the api app doesn't hold direct API keys.
      Provider-side rate limiter + timeout decisions stay encapsulated;
      callers swallow per-provider failures via `Promise.allSettled`. */
  searchTokens?(query: string, limit?: number): Promise<TokenSearchResult[]>;
}

export interface AIInferenceProvider extends ProviderBase {
  /** Vision: extract structured data from a portfolio screenshot or
      PDF page. */
  parseScreenshot(input: {
    imageBase64: string;
    mimeType: string;
    hint?: string;
  }): Promise<unknown>;
  /** Text: parse a CSV header / OFX free-text field for column
      detection. */
  parseDocumentText?(text: string, hint?: string): Promise<unknown>;
  /** Generic completion. Used by smaller helpers (token-name
      cleanup, etc.). */
  completeText?(
    prompt: string,
    opts?: { temperature?: number; maxTokens?: number }
  ): Promise<string>;
}

// ============================================================================
// Self-credentialed capabilities (ctx.credentialsRef REQUIRED)
// ============================================================================

export interface BalanceProvider extends ProviderBase {
  canFetchBalances(institutionCode: string): boolean;
  fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]>;
}

export interface TransactionsProvider extends ProviderBase {
  canFetchTransactions(institutionCode: string): boolean;
  fetchTransactions(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]>;
}

export interface CredentialValidator extends ProviderBase {
  /** Validate a fresh credential at integration setup time. Receives
      the plaintext directly because the validation flow happens before
      the credential is persisted, so there's nothing to resolve. */
  validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }>;
}

/**
 * Address-shape validation + on-chain activity probing + name resolution
 * for institutions whose "credential" is just a public address (chains).
 *
 * Pool-credentialed: every method here works against public endpoints.
 * No `WithUserCreds` brand — the `WalletDiscoveryService` calls these
 * before the user has any credential at all (the address probe drives
 * the integration-picker UI).
 */
export interface AddressValidatorProvider extends ProviderBase {
  /** Per-institution gate. */
  canValidate(institutionCode: string): boolean;
  /** Cheap syntactic check (regex / checksum). No network. */
  isValidAddress(address: string, institutionCode: string): boolean;
  /** Lightweight existence probe — one tx call, short page. Used by
      `detectWalletChains` to decide which chains an address actually
      lives on. */
  hasActivity(address: string, institutionCode: string, ctx: ProviderContext): Promise<boolean>;
  /** ENS / NS / domain resolution. Optional — only Etherscan implements. */
  resolveAddressName?(name: string, ctx: ProviderContext): Promise<string | null>;
}

/**
 * Multi-account discovery for venues that expose more than one account
 * per credential (IBKR Flex Query, Wise multi-currency, Binance
 * spot/margin/futures, Coinbase portfolios).
 *
 * Self-credentialed: discovering accounts always requires the user's
 * own credentials.
 */
export interface AccountDiscoveryProvider extends ProviderBase {
  canDiscoverAccounts(institutionCode: string): boolean;
  fetchAccounts(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<DiscoveredAccount[]>;
}

// ============================================================================
// Type guards — used by ProviderRegistry.register() to duck-type
// ============================================================================

export function isCurrentPriceProvider(p: unknown): p is CurrentPriceProvider {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as CurrentPriceProvider).canPrice === 'function' &&
    typeof (p as CurrentPriceProvider).fetchCurrentPrice === 'function'
  );
}

export function isHistoricalPriceProvider(p: unknown): p is HistoricalPriceProvider {
  return (
    isCurrentPriceProvider(p) &&
    typeof (p as HistoricalPriceProvider).fetchHistoricalPrice === 'function'
  );
}

export function isBalanceProvider(p: unknown): p is BalanceProvider {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as BalanceProvider).canFetchBalances === 'function' &&
    typeof (p as BalanceProvider).fetchBalances === 'function'
  );
}

export function isTransactionsProvider(p: unknown): p is TransactionsProvider {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as TransactionsProvider).canFetchTransactions === 'function' &&
    typeof (p as TransactionsProvider).fetchTransactions === 'function'
  );
}

export function isTokenIdentityProvider(p: unknown): p is TokenIdentityProvider {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as TokenIdentityProvider).enrichTokenIdentity === 'function'
  );
}

export function isCredentialValidator(p: unknown): p is CredentialValidator {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as CredentialValidator).validateCredentials === 'function'
  );
}

export function isAIInferenceProvider(p: unknown): p is AIInferenceProvider {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as AIInferenceProvider).parseScreenshot === 'function'
  );
}

export function isAddressValidatorProvider(p: unknown): p is AddressValidatorProvider {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as AddressValidatorProvider).canValidate === 'function' &&
    typeof (p as AddressValidatorProvider).isValidAddress === 'function' &&
    typeof (p as AddressValidatorProvider).hasActivity === 'function'
  );
}

export function isAccountDiscoveryProvider(p: unknown): p is AccountDiscoveryProvider {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as AccountDiscoveryProvider).canDiscoverAccounts === 'function' &&
    typeof (p as AccountDiscoveryProvider).fetchAccounts === 'function'
  );
}
