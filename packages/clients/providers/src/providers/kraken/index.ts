/**
 * `KrakenProvider` — the canonical CEX provider implementation.
 *
 * Kraken is uniquely useful as a reference because its `/private/
 * Ledgers` endpoint exposes one unified feed for trades, deposits,
 * withdrawals, staking rewards, and earn accruals. Other CEX providers
 * (Binance, Coinbase, …) need to merge several endpoints; Kraken
 * doesn't, which makes it the cleanest worked example.
 *
 * Capabilities:
 *  - `current-balances`  → `/private/Balance` (Kraken's only balance
 *                          endpoint).
 *  - `transactions`      → `/private/Ledgers`, paginated with `ofs`.
 *                          Asset codes normalized via `normalizeKrakenAsset`.
 *  - `credential-validator` → tries `/private/Balance` and surfaces the
 *                          actual EAPI error string on failure.
 *  - `historical-price`  → out of scope here; the OHLC endpoint is
 *                          public and pool-credentialed via a future
 *                          `KrakenOhlcProvider` (planned in the same
 *                          directory but kept separate so it can be
 *                          loaded independently).
 *
 * Pre-refactor sources combined:
 *  - `packages/integrations/src/services/KrakenApiService.ts`
 *  - `packages/integrations/src/factories/krakenFactory.ts`
 *  - `packages/integrations/src/ingesters/KrakenTransactionIngester.ts`
 *  - `packages/integrations/src/rate-limiters/kraken.ts`
 *  - `packages/integrations/src/implementations/KrakenIntegration.ts`
 *
 * Five files become two (api-service.ts + index.ts) plus the asset
 * normalizer; everything else folds into the provider class.
 */

import type { NewToken, Token } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { createOutflowLimiter } from '@scani/rate-limiter';
import { BaseCexProvider, type CexNormalizedEvent } from '../../core/base/base-cex-provider';
import type { ProviderFactory } from '../../core/boot';
import type {
  BalanceProvider,
  Capability,
  CredentialValidator,
  HistoricalPriceProvider,
  TransactionsProvider,
} from '../../core/capabilities';
import type {
  DecryptedCredentials,
  HoldingSnapshot,
  PriceQuote,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from '../../core/types';
import { type KrakenApiService, KrakenApiService as KrakenApiServiceClass } from './api-service';
import { isKrakenFiatAsset, normalizeKrakenAsset } from './asset-normalizer';
import { fetchKrakenHistoricalPrice, readKrakenAssetCode } from './kraken-ohlc';
import { krakenManifest } from './manifest';

export { krakenManifest } from './manifest';

const KRAKEN_INSTITUTION_CODE = 'kraken';
const KRAKEN_BASE_URL = 'https://api.kraken.com';

// Server-side cap on Ledgers page size; we drive pagination via `ofs`.
const LEDGER_PAGE_SIZE = 50;
const MAX_LEDGER_PAGES = 400; // 20,000 row hard stop.

/**
 * Cooldown between paginated Ledgers calls.
 *
 * Kraken weights `/private/Ledgers` at 2 counter units per call. The
 * counter drains at 0.33–1.0 units/sec depending on verification
 * tier. Spacing pages by ~2.2s keeps us safe on Pro tier and well
 * under on lower tiers; without it a user with a few thousand ledger
 * rows trips `EAPI:Rate limit exceeded` mid-pagination.
 */
const PAGE_COOLDOWN_MS = 2_200;

/**
 * Map a Kraken ledger `type` to our `kind` taxonomy. The base class
 * re-asserts sign from `kind`, so this mapping has to match the
 * direction the ledger row's `amount` is moving.
 */
function mapKrakenKind(type: string, amountIsPositive: boolean): CexNormalizedEvent['kind'] {
  switch (type) {
    case 'trade':
    case 'spend':
      return amountIsPositive ? 'buy' : 'sell';
    case 'receive':
      return 'buy';
    case 'deposit':
      return 'deposit';
    case 'withdrawal':
      return 'withdraw';
    case 'staking':
    case 'reward':
    case 'earn':
      return 'reward';
    default:
      return amountIsPositive ? 'deposit' : 'withdraw';
  }
}

export class KrakenProvider
  extends BaseCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator, HistoricalPriceProvider
{
  readonly providerKey = 'kraken';
  readonly manifest = krakenManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
    'historical-price',
  ];

  protected readonly logger: CustomLogger;

  constructor(private readonly api: KrakenApiService) {
    super();
    this.logger = createComponentLogger('provider:kraken');
  }

  // ============================================================
  // BalanceProvider
  // ============================================================

  canFetchBalances(institutionCode: string): boolean {
    return institutionCode === KRAKEN_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) return [];

    const balances = await this.api.getBalances(apiKey, apiSecret);
    const out: HoldingSnapshot[] = [];
    for (const { asset, balance } of balances) {
      if (!balance || balance === '0' || balance === '0.00000000') continue;
      const symbol = normalizeKrakenAsset(asset);
      out.push({
        externalId: asset,
        tokenIdentity: this.assetIdentity(asset),
        balance,
        capturedAt: new Date(),
        // Tag fiat assets so the orchestrator routes them through
        // Frankfurter for FX rates instead of CoinGecko/DeFiLlama
        // (which would either return nothing or — worse — match a
        // scam token claiming the same ticker).
        tokenType: isKrakenFiatAsset(asset) ? 'fiat' : 'crypto',
      });
      // Symbol used for the dedup-friendly identity below; the variable
      // is captured by reference inside the closure when the federated
      // identity flow probes other providers.
      void symbol;
    }
    return out;
  }

  // ============================================================
  // TransactionsProvider
  // ============================================================

  canFetchTransactions(institutionCode: string): boolean {
    return institutionCode === KRAKEN_INSTITUTION_CODE;
  }

  async fetchTransactions(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]> {
    return this.fetchTransactionsViaPagination(ctx);
  }

  // ============================================================
  // CredentialValidator
  // ============================================================

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== KRAKEN_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) {
      return { valid: false, message: 'apiKey and apiSecret are required' };
    }
    try {
      await this.api.validateApiKey(apiKey, apiSecret);
      return { valid: true };
    } catch (err) {
      return {
        valid: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ============================================================
  // BaseCexProvider implementation
  // ============================================================

  protected mapAssetIdentity(assetCode: string): Partial<NewToken> | null {
    return this.assetIdentity(assetCode);
  }

  /**
   * Drive ledger pagination via `ofs` (Kraken's row-offset cursor),
   * sleeping between pages to stay under the decaying-counter
   * budget. Yields one `CexNormalizedEvent` per ledger row; the
   * base class converts those to `TransactionEvent` with sign
   * enforcement.
   */
  protected async *fetchHistoryPaginated(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): AsyncGenerator<CexNormalizedEvent, { hasCompleteTxHistory: boolean }, void> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) {
      this.logger.warn(
        { providerKey: this.providerKey },
        'Kraken tx history: missing apiKey/apiSecret'
      );
      return { hasCompleteTxHistory: false };
    }

    const startSec = ctx.since ? Math.floor(ctx.since.getTime() / 1000) : undefined;
    const untilSec = ctx.until ? Math.floor(ctx.until.getTime() / 1000) : undefined;

    let ofs = 0;
    let page = 0;
    let truncated = false;

    while (page < MAX_LEDGER_PAGES) {
      const response = await this.api.fetchLedgers(apiKey, apiSecret, {
        start: startSec,
        end: untilSec,
        ofs,
      });
      const entries = Object.entries(response.ledger);
      if (entries.length === 0) break;

      for (const [ledgerId, entry] of entries) {
        const amt = Number.parseFloat(entry.amount);
        if (!Number.isFinite(amt) || amt === 0) continue;
        const positive = amt > 0;
        const kind = mapKrakenKind(entry.type, positive);
        const asset = normalizeKrakenAsset(entry.asset);
        const feeNum = Number.parseFloat(entry.fee);

        yield {
          kind,
          assetCode: asset,
          quantity: entry.amount,
          feeAssetCode: feeNum > 0 ? asset : undefined,
          feeQuantity: feeNum > 0 ? entry.fee : undefined,
          occurredAt: new Date(entry.time * 1000),
          externalId: ledgerId,
          rawPayload: entry,
        };
      }

      ofs += entries.length;
      page += 1;
      if (ofs >= response.count) break;
      if (page === MAX_LEDGER_PAGES - 1) truncated = true;
      if (entries.length < LEDGER_PAGE_SIZE) break;

      await new Promise((r) => setTimeout(r, PAGE_COOLDOWN_MS));
    }

    return { hasCompleteTxHistory: !truncated };
  }

  // ============================================================
  // HistoricalPriceProvider — public OHLC for Kraken-native assets
  // ============================================================

  // `canPrice` gates BOTH historical and current pricing in
  // `ProviderRegistry.getCurrentPricers` / `getHistoricalPricers`.
  // Returning `true` only for tokens carrying a `kraken.asset`
  // metadata namespace means we never get asked about random
  // CoinGecko-imported assets, but we DO get the chance to price
  // user-imported Kraken holdings (XXBT, ZEUR, …) that DeFiLlama
  // and CoinGecko's symbol index miss.
  canPrice(t: Token): boolean {
    return readKrakenAssetCode(t) !== null;
  }

  // Live-pricing path: defer to CoinGecko/DeFiLlama/Finnhub. The
  // public ticker endpoint exists but has no advantage over the
  // dedicated current-price providers and would just thrash Kraken's
  // rate limit. Returning null lets the registry's priority order
  // pick the next provider.
  async fetchCurrentPrice(_t: Token, _ctx: ProviderContext): Promise<PriceQuote | null> {
    return null;
  }

  async fetchHistoricalPrice(t: Token, at: Date, ctx: ProviderContext): Promise<PriceQuote | null> {
    return fetchKrakenHistoricalPrice(t, at, ctx);
  }

  // ============================================================
  // Internals
  // ============================================================

  /**
   * Build a `Partial<NewToken>` identity hint from a Kraken raw
   * asset code. The orchestrator's `findOrCreateByIdentity` flow
   * looks up `(symbol, typeId, marketSegment)` first, then enriches
   * via the federated identity providers — Kraken records its raw
   * asset code in the `kraken` namespace so future Kraken-specific
   * lookups (e.g. listing trades for a token) hit the right asset.
   */
  private assetIdentity(rawAsset: string): Partial<NewToken> {
    const symbol = normalizeKrakenAsset(rawAsset);
    return {
      symbol,
      name: symbol,
      providerMetadata: { kraken: { asset: rawAsset } },
    };
  }
}

export const krakenFactory: ProviderFactory = async (deps) => {
  // Kraken private API: 1 req / 2s sustained for `/private/Ledgers`
  // (counter weight 2, drain rate 0.5-1 units/s). `getBalances` is
  // weight 1, so the same limiter handles both.
  const limiter = createOutflowLimiter({
    maxRequests: 1,
    windowMs: 2_000,
    redis: deps.redis ?? undefined,
    namespace: 'kraken-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'kraken-private',
    limiter,
    registeredFrom: 'providers/kraken',
    description: 'Kraken private API: 1 req / 2s per API key',
  });
  const api = new KrakenApiServiceClass(KRAKEN_BASE_URL, registered);
  return new KrakenProvider(api);
};

export type { KrakenLedgerEntry } from './api-service';
export { normalizeKrakenAsset } from './asset-normalizer';
