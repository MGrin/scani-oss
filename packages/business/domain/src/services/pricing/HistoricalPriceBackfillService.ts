import { createComponentLogger } from '@scani/logging';
import type { HistoricalPriceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { PriceQuote, ProviderContext } from '@scani/providers/core/types';
import { Container, Service } from 'typedi';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';

// Providers whose universe is equities + fiat — they MUST NOT be
// asked to price crypto tokens. Yahoo Finance and Finnhub both
// return ETF / equity look-alikes when fed a crypto ticker (Yahoo
// returns the ProShares ETH ETF for "ETH", giving ~$22 instead of
// ~$2300 — see prod incident 2026-05-06). Crypto tickers route to
// CoinGecko / DeFiLlama / Kraken / Binance instead.
const EQUITY_ONLY_PROVIDER_KEYS = new Set(['yahoo-finance', 'finnhub']);

// Providers whose universe is crypto only — they MUST NOT be asked to
// price stock or fiat tokens. DeFiLlama / CoinGecko match by ticker and
// return a same-symbol memecoin's price for an equity (DeFiLlama
// returned ~$0.04 for the stock BLK, oscillating the chart against the
// correct Yahoo ~$1000 row — prod incident 2026-05). Kraken / Binance
// only cover exchange-listed crypto pairs.
const CRYPTO_ONLY_PROVIDER_KEYS = new Set(['defillama', 'coingecko', 'kraken', 'binance']);

export interface BackfillOneResult {
  tokenId: string;
  baseTokenId: string;
  at: Date;
  status: 'inserted' | 'already-have' | 'provider-missing' | 'no-provider';
  priceStored?: string;
  providerUsed?: string;
}

export interface BackfillManyRequest {
  tokenId: string;
  at: Date;
  // Optional explicit base; default = user's display base or USD.
  baseTokenId?: string;
}

/**
 * Central service for writing historical price rows. Walks the registry's
 * `HistoricalPriceProvider` list (priority order = registration order),
 * picks the first one that satisfies `canPrice(token)`, and asks for a
 * historical close at `at`.
 *
 * Writes land in `token_prices` with `granularity='daily'` and
 * `source='<provider>_historical'`. Idempotent via the table's unique
 * constraint on (token_id, base_token_id, timestamp) — re-running the
 * backfill for the same date is a no-op unless the provider returned
 * a materially different price (in which case it overwrites, matching
 * the existing bulkUpsert semantics).
 *
 * Providers come from `ProviderRegistry.getHistoricalPricers(token)`;
 * provider boot wiring lives in `apps/{worker,cron,backend}/src/index.ts`'s
 * `buildProviderRegistry` call. CEX providers like Kraken are wired
 * here too — their public OHLC endpoint covers exchange-native asset
 * codes (XXBT, ZUSD, …) that DeFiLlama/CoinGecko can't see.
 */
@Service()
export class HistoricalPriceBackfillService {
  private readonly logger = createComponentLogger('service:HistoricalPriceBackfillService');

  // Class-field DI — see note in BalanceAtTimeService.ts.
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly tokenRepository = Container.get(TokenRepository);

  // Backfill a single (token, at) against a specific base. Stores if any
  // provider returned a value. Idempotent across re-runs for the same
  // (token, base, provider-timestamp) — the DB unique constraint wins.
  async backfillOne(tokenId: string, at: Date, baseTokenId: string): Promise<BackfillOneResult> {
    const token = await this.tokenRepository.findWithType(tokenId);
    const baseToken = await this.tokenRepository.findById(baseTokenId);
    if (!token || !baseToken) {
      return {
        tokenId,
        baseTokenId,
        at,
        status: 'no-provider',
      };
    }

    // Fast path: already have a daily price on this token for this date.
    const existing = await this.tokenPriceRepository.findClosestPriceByGranularity(
      tokenId,
      baseTokenId,
      at,
      'daily'
    );
    if (existing && Math.abs(existing.timestamp.getTime() - at.getTime()) < 24 * 60 * 60 * 1000) {
      return {
        tokenId,
        baseTokenId,
        at,
        status: 'already-have',
        priceStored: existing.price,
        providerUsed: existing.source ?? undefined,
      };
    }

    const ctx: ProviderContext = { baseCurrency: baseToken, timestamp: at };
    const registry = Container.get(ProviderRegistry);
    const providers = filterProvidersByTokenType(
      registry.getHistoricalPricers(token),
      token.typeCode
    );

    if (providers.length === 0) {
      return {
        tokenId,
        baseTokenId,
        at,
        status: 'provider-missing',
      };
    }

    for (const provider of providers) {
      try {
        const result = await provider.fetchHistoricalPrice(token, at, ctx);
        if (!result) continue;

        await this.tokenPriceRepository.bulkUpsertDailyBackfill([
          {
            tokenId,
            baseTokenId,
            price: result.price,
            timestamp: result.timestamp,
            source: result.source,
          },
        ]);

        return {
          tokenId,
          baseTokenId,
          at,
          status: 'inserted',
          priceStored: result.price,
          providerUsed: provider.providerKey,
        };
      } catch (error) {
        this.logger.warn(
          {
            provider: provider.providerKey,
            tokenId,
            baseTokenId,
            at,
            error: error instanceof Error ? error.message : error,
          },
          'Historical provider threw during backfill; trying next'
        );
      }
    }

    return {
      tokenId,
      baseTokenId,
      at,
      status: 'provider-missing',
    };
  }

  // Backfill a batch. Serial on purpose — DeFiLlama's free tier is
  // generous but a burst of 500 parallel requests can still 429 us. If
  // a single lookup returns 'provider-missing' we just continue; the
  // caller can retry those later.
  async backfillMany(
    items: BackfillManyRequest[],
    defaultBaseTokenId: string
  ): Promise<BackfillOneResult[]> {
    const results: BackfillOneResult[] = [];
    for (const item of items) {
      const baseId = item.baseTokenId ?? defaultBaseTokenId;
      const r = await this.backfillOne(item.tokenId, item.at, baseId);
      results.push(r);
    }
    return results;
  }

  /**
   * Backfill a contiguous range for ONE token in as few HTTP calls as
   * possible. Replaces the per-(token, day) loop in the old use-case
   * orchestrator with a single range fetch per token, falling back to
   * parallel per-day calls when the chosen provider has no range API.
   *
   * For Finnhub / Yahoo / Frankfurter (range-aware), this collapses
   * 365 sequential calls to one, turning a 5-minute backfill into
   * 5 seconds.
   *
   * Caller passes the SET of `neededDays` (already deduped against
   * `token_prices`) — the method asks the provider for the spanning
   * range, then bulk-upserts every quote that falls inside neededDays.
   * Quotes outside neededDays (provider returned more days than asked)
   * are still persisted because they're free coverage.
   *
   * Returns counts so the use-case can aggregate into BackfillSummary.
   */
  async backfillTokenRange(
    tokenId: string,
    baseTokenId: string,
    neededDays: Date[]
  ): Promise<{
    inserted: number;
    alreadyHad: number;
    providerMissing: number;
    providerUsed: string | null;
  }> {
    const empty = { inserted: 0, alreadyHad: 0, providerMissing: 0, providerUsed: null };
    if (neededDays.length === 0) return empty;

    const token = await this.tokenRepository.findWithType(tokenId);
    const baseToken = await this.tokenRepository.findById(baseTokenId);
    if (!token || !baseToken) {
      return { ...empty, providerMissing: neededDays.length };
    }

    // Span derived from the needed-days set; the provider will return
    // every business day in [from, to], which usually covers more than
    // neededDays — extra coverage is a bonus.
    const sorted = [...neededDays].sort((a, b) => a.getTime() - b.getTime());
    const from = sorted[0];
    const to = sorted[sorted.length - 1];
    if (!from || !to) return empty;

    const ctx: ProviderContext = { baseCurrency: baseToken, timestamp: to };
    const registry = Container.get(ProviderRegistry);
    const providers = filterProvidersByTokenType(
      registry.getHistoricalPricers(token),
      token.typeCode
    );
    if (providers.length === 0) {
      return { ...empty, providerMissing: neededDays.length };
    }

    // Try providers in registration order; first one that returns ≥1
    // quote wins. We don't merge across providers because that
    // complicates source attribution — one provider per token-range
    // is the right granularity for "this curve came from X".
    for (const provider of providers) {
      const quotes = provider.fetchHistoricalRange
        ? await this.tryRangeFetch(provider, token, from, to, ctx)
        : await this.tryPerDayFetch(provider, token, neededDays, ctx);
      if (quotes.length === 0) continue;

      await this.tokenPriceRepository.bulkUpsertDailyBackfill(
        quotes.map((q) => ({
          tokenId,
          baseTokenId,
          price: q.price,
          timestamp: q.timestamp,
          source: q.source,
        }))
      );

      // Days from neededDays that the provider covered (within ±24h).
      const coveredDayKeys = new Set(quotes.map((q) => q.timestamp.toISOString().slice(0, 10)));
      let inserted = 0;
      let providerMissing = 0;
      for (const day of neededDays) {
        const key = day.toISOString().slice(0, 10);
        if (coveredDayKeys.has(key)) inserted++;
        else providerMissing++;
      }
      return {
        inserted,
        alreadyHad: 0,
        providerMissing,
        providerUsed: provider.providerKey,
      };
    }

    return { ...empty, providerMissing: neededDays.length };
  }

  // Range fetch via the provider's optional fetchHistoricalRange. One
  // HTTP call returns N quotes covering the requested period.
  private async tryRangeFetch(
    provider: HistoricalPriceProvider,
    token: NonNullable<Awaited<ReturnType<TokenRepository['findById']>>>,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    if (!provider.fetchHistoricalRange) return [];
    try {
      const result = await provider.fetchHistoricalRange(token, from, to, ctx);
      return Array.isArray(result) ? result.filter((q): q is PriceQuote => Boolean(q)) : [];
    } catch (err) {
      this.logger.warn(
        {
          provider: provider.providerKey,
          tokenId: token.id,
          from,
          to,
          error: err instanceof Error ? err.message : err,
        },
        'Provider range fetch threw; falling through'
      );
      return [];
    }
  }

  // Fallback when a provider doesn't expose fetchHistoricalRange. Runs
  // per-day calls in parallel within the provider's own rate limiter
  // (every provider wraps its fetch in `limiter.execute`), so this is
  // automatically throttled — no need for an outer concurrency cap.
  private async tryPerDayFetch(
    provider: HistoricalPriceProvider,
    token: NonNullable<Awaited<ReturnType<TokenRepository['findById']>>>,
    days: Date[],
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    const settled = await Promise.allSettled(
      days.map((day) => provider.fetchHistoricalPrice(token, day, ctx))
    );
    const out: PriceQuote[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) out.push(result.value);
    }
    return out;
  }
}

// Restrict the historical-pricer list to providers whose asset
// universe matches the token's type. Equity providers can't tell
// ETH-the-coin from ETH-the-ETF; crypto providers match a stock
// ticker to a same-symbol coin. typeCode is cheaply available here
// (the service does a `findWithType` lookup right before this call),
// so the filter lives here rather than in each provider's canPrice.
// Unknown / 'other' / 'private-company' types keep every provider —
// best-effort, since none of the type-specific hazards apply.
//
// Exported for unit testing — the pure routing decision is the part
// worth covering directly.
export function filterProvidersByTokenType<P extends { providerKey: string }>(
  providers: readonly P[],
  typeCode: string | null | undefined
): readonly P[] {
  if (typeCode === 'crypto') {
    return providers.filter((p) => !EQUITY_ONLY_PROVIDER_KEYS.has(p.providerKey));
  }
  if (typeCode === 'stock' || typeCode === 'fiat') {
    return providers.filter((p) => !CRYPTO_ONLY_PROVIDER_KEYS.has(p.providerKey));
  }
  return providers;
}
