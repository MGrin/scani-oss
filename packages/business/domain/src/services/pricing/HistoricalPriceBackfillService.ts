import { createComponentLogger } from '@scani/logging';
import type { HistoricalPriceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { PriceQuote, ProviderContext } from '@scani/providers/core/types';
import { Container, Service } from 'typedi';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { isStorablePrice, PriceWriter } from './PriceWriter';
import { hasExternalPricingAuthority } from './token-type-pricing';

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

const DAY_MS = 24 * 60 * 60 * 1000;

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

const utcDayStart = (at: Date) => Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());

/** Where a quote is stored, and the UTC day it is for (D-8). */
interface Placement {
  quote: PriceQuote;
  day: string;
  at: Date;
  granularity: 'daily' | 'intraday';
}

/**
 * A close of a past day lands on that day's last millisecond. Today has no
 * close, so its bar is a price at the fetch instant; a price at an instant
 * keeps its own. A cloud that predates `barDay` is stored as it always was.
 */
export function placementOf(quote: PriceQuote, now: Date): Placement {
  const today = dayOf(now);
  if (quote.legacyDaily) {
    return { quote, day: dayOf(quote.timestamp), at: quote.timestamp, granularity: 'daily' };
  }
  if (quote.barDay === null) {
    return { quote, day: dayOf(quote.timestamp), at: quote.timestamp, granularity: 'intraday' };
  }
  if (quote.barDay < today) {
    return {
      quote,
      day: quote.barDay,
      at: new Date(`${quote.barDay}T23:59:59.999Z`),
      granularity: 'daily',
    };
  }
  return { quote, day: today, at: now, granularity: 'intraday' };
}

/** One placement per stored key: the quote the provider stamped last. */
function latestPerKey(placements: readonly Placement[]): Placement[] {
  const byKey = new Map<string, Placement>();
  for (const placement of placements) {
    const key = `${placement.at.getTime()}|${placement.granularity}`;
    const kept = byKey.get(key);
    if (!kept || placement.quote.timestamp.getTime() > kept.quote.timestamp.getTime()) {
      byKey.set(key, placement);
    }
  }
  return [...byKey.values()];
}

@Service()
export class HistoricalPriceBackfillService {
  private readonly logger = createComponentLogger('service:HistoricalPriceBackfillService');

  // Class-field DI — see `.claude/rules/typedi-di.md`.
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly priceWriter = Container.get(PriceWriter);

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
   * range, then fills only UTC days that are not covered
   * (`TokenPriceRepository.findPricedDayKeys`). Each quote is stored for the
   * day its bar closes (`placementOf`), which can lie outside the requested
   * days, and fills that day when it is not covered.
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
    // Needed days a provider answered only with bars the writer does not
    // store. Neither inserted nor missing, so with those two and `alreadyHad`
    // they add up to the days asked.
    droppedDays: number;
    // Bars the writer did not store, on any day the provider returned.
    droppedBars: number;
    providerUsed: string | null;
    // True when a provider attempt FAILED rather than answering with an
    // empty range. The caller must not conclude anything about the
    // token's priceability from a run that never got an answer — see
    // `attemptFailed` handling in BackfillHistoricalPricesUseCase.
    attemptFailed: boolean;
  }> {
    const empty = {
      inserted: 0,
      alreadyHad: 0,
      providerMissing: 0,
      droppedDays: 0,
      droppedBars: 0,
      providerUsed: null,
      attemptFailed: false,
    };
    if (neededDays.length === 0) return empty;

    const token = await this.tokenRepository.findWithType(tokenId);
    const baseToken = await this.tokenRepository.findById(baseTokenId);
    if (!token || !baseToken) {
      return { ...empty, providerMissing: neededDays.length };
    }

    // One clock read: the request's end, what "today" is, and the stamp of
    // today's bar are the same instant.
    const now = new Date();
    const sorted = [...neededDays].sort((a, b) => a.getTime() - b.getTime());
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!first || !last) return empty;
    // From the day before the first needed day, because a bar can be stamped
    // late on the day before the one it closes (Yahoo's =X in summer, at 23:00
    // UTC); to the midnight that ends the last needed day, where a provider
    // stamps that day's close, and never past now.
    const from = new Date(utcDayStart(first) - DAY_MS);
    const to = new Date(Math.min(utcDayStart(last) + DAY_MS, now.getTime()));

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
    //
    // `attemptFailed` accumulates across providers: if ANY of them threw
    // rather than answering, this run has not established that the token
    // is unpriceable, no matter how many others answered empty.
    let attemptFailed = false;
    for (const provider of providers) {
      const attempt = provider.fetchHistoricalRange
        ? await this.tryRangeFetch(provider, token, from, to, ctx)
        : await this.tryPerDayFetch(provider, token, neededDays, ctx);
      if (attempt.failed) attemptFailed = true;
      const quotes = attempt.quotes;
      if (quotes.length === 0) continue;

      const placements = quotes.map((q) => placementOf(q, now));
      const earliest = Math.min(
        from.getTime(),
        ...placements.map((p) => Date.parse(`${p.day}T00:00:00.000Z`))
      );
      const existingDays = await this.tokenPriceRepository.findPricedDayKeys({
        baseTokenId,
        tokenIds: [tokenId],
        since: new Date(earliest),
        now,
      });
      const uncovered = placements.filter((p) => !existingDays.has(`${tokenId}:${p.day}`));
      const storable = uncovered.filter((p) => isStorablePrice(p.quote.price));
      // Only a storable quote may win its key: a later one the writer would
      // drop must not displace an earlier close. The rest still reach the
      // writer so `droppedBars` counts them.
      const missing = [
        ...latestPerKey(storable),
        ...uncovered.filter((p) => !isStorablePrice(p.quote.price)),
      ];
      const written = await this.priceWriter.writeHistory(
        missing.map((p) => ({
          tokenId,
          baseTokenId,
          price: p.quote.price,
          at: p.at,
          granularity: p.granularity,
          source: p.quote.source,
        }))
      );

      // Days the provider answered that were not covered; of those, the ones
      // a storable bar was sent for; of those, the ones the table took. A day
      // whose bar the table refused holds another source's close.
      const answeredDays = new Set(missing.map((p) => p.day));
      const sentDays = new Set(storable.map((p) => p.day));
      const acceptedDays = new Set(written.accepted.map((key) => dayOf(key.at)));
      let inserted = 0;
      let alreadyHad = 0;
      let providerMissing = 0;
      let droppedDays = 0;
      for (const day of neededDays) {
        const key = dayOf(day);
        if (existingDays.has(`${tokenId}:${key}`)) alreadyHad++;
        else if (acceptedDays.has(key)) inserted++;
        else if (sentDays.has(key)) alreadyHad++;
        else if (answeredDays.has(key)) droppedDays++;
        else providerMissing++;
      }
      return {
        inserted,
        alreadyHad,
        providerMissing,
        droppedDays,
        droppedBars: written.dropped,
        providerUsed: provider.providerKey,
        attemptFailed,
      };
    }

    return { ...empty, providerMissing: neededDays.length, attemptFailed };
  }

  // Range fetch via the provider's optional fetchHistoricalRange. One
  // HTTP call returns N quotes covering the requested period.
  //
  // `failed` separates "the provider answered, with nothing" from "we
  // never got an answer". Both used to return `[]` and the caller could
  // not tell them apart, which is how a malformed request became a
  // week-long unpriceable cooldown (SC-171).
  private async tryRangeFetch(
    provider: HistoricalPriceProvider,
    token: NonNullable<Awaited<ReturnType<TokenRepository['findById']>>>,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<ProviderAttempt> {
    if (!provider.fetchHistoricalRange) return { quotes: [], failed: false };
    try {
      const result = await provider.fetchHistoricalRange(token, from, to, ctx);
      const quotes = Array.isArray(result) ? result.filter((q): q is PriceQuote => Boolean(q)) : [];
      return { quotes, failed: false };
    } catch (err) {
      this.logger.warn(
        {
          provider: provider.providerKey,
          tokenId: token.id,
          from,
          to,
          error: err instanceof Error ? err.message : err,
        },
        'Provider range fetch threw; falling through without judging the token'
      );
      return { quotes: [], failed: true };
    }
  }

  // Fallback when a provider doesn't expose fetchHistoricalRange. Runs
  // per-day calls in parallel within the provider's own rate limiter
  // (every provider wraps its fetch in `limiter.execute`), so this is
  // automatically throttled — no need for an outer concurrency cap.
  //
  // A single rejected day is enough to set `failed`: the run then knows
  // it saw an error, and declines to conclude the token is unpriceable.
  private async tryPerDayFetch(
    provider: HistoricalPriceProvider,
    token: NonNullable<Awaited<ReturnType<TokenRepository['findById']>>>,
    days: Date[],
    ctx: ProviderContext
  ): Promise<ProviderAttempt> {
    const settled = await Promise.allSettled(
      days.map((day) => provider.fetchHistoricalPrice(token, day, ctx))
    );
    const out: PriceQuote[] = [];
    let failed = false;
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        if (result.value) out.push(result.value);
      } else {
        failed = true;
      }
    }
    if (failed) {
      this.logger.warn(
        { provider: provider.providerKey, tokenId: token.id, days: days.length },
        'Per-day fetch had rejections; not judging the token from this run'
      );
    }
    return { quotes: out, failed };
  }
}

// One provider's answer to a range request: what it returned, and
// whether it returned at all.
interface ProviderAttempt {
  quotes: PriceQuote[];
  failed: boolean;
}

// Restrict the historical-pricer list to providers whose asset
// universe matches the token's type. Equity providers can't tell
// ETH-the-coin from ETH-the-ETF; crypto providers match a stock
// ticker to a same-symbol coin. typeCode is cheaply available here
// (the service does a `findWithType` lookup right before this call),
// so the filter lives here rather than in each provider's canPrice.
//
// A type with no external pricing authority gets NO provider, which is
// `PricingProviderRouter`'s answer for the same token read off the same table
// (SC-1115). This used to read "unknown / 'other' / 'private-company' types
// keep every provider — best-effort, since none of the type-specific hazards
// apply", and that reasoning inverted the fact two lines above it: the hazard
// named there is a crypto provider matching a same-symbol coin, and a
// `private-company` token is precisely a symbol with no chain behind it. It is
// the MOST exposed type, not an exempt one.
//
// Exported for unit testing — the pure routing decision is the part
// worth covering directly.
export function filterProvidersByTokenType<P extends { providerKey: string }>(
  providers: readonly P[],
  typeCode: string | null | undefined
): readonly P[] {
  if (!hasExternalPricingAuthority(typeCode)) return [];
  if (typeCode === 'crypto') {
    return providers.filter((p) => !EQUITY_ONLY_PROVIDER_KEYS.has(p.providerKey));
  }
  if (typeCode === 'stock' || typeCode === 'fiat') {
    return providers.filter((p) => !CRYPTO_ONLY_PROVIDER_KEYS.has(p.providerKey));
  }
  return providers;
}
