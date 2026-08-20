import { createComponentLogger, logger } from '@scani/logging';
import { OutflowRateLimiterRegistry } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { PriceGraphService } from './PriceGraphService';
import { PRICE_HUBS } from './price-hubs';
import { EXCHANGERATE_LIMIT } from './upstream-rate-limits';

const currencyLogger = createComponentLogger('pricing:currency');

// `https://api.exchangerate-api.com/v4/latest/{base}` — the `/latest/`
// segment is required; the previous `/v4/{base}` form silently 404'd
// in production, leaving every CAD/EUR/GBP/etc. holding stranded with
// price=0 because every conversion call returned `'0'`.
const EXCHANGERATE_BASE_URL = 'https://api.exchangerate-api.com/v4/latest';
const EXCHANGERATE_FETCH_TIMEOUT_MS = 8000;

// Currencies warmed from one upstream response at api boot. All fiat, so
// they resolve unambiguously by (symbol, fiat type) — unlike `PRICE_HUBS`,
// which deliberately contains a crypto stablecoin.
const PREWARM_FIAT_SYMBOLS = ['USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD'] as const;

/**
 * The identity of one side of a conversion: which `tokens` row, and what to
 * call it upstream.
 *
 * A symbol alone cannot address a currency here. `tokens` is unique on
 * `(symbol, type_id, COALESCE(market_segment,''))`, so eight symbols in
 * production have more than one legitimate row — `SOS` has both a fiat
 * currency and a memecoin, and `USDT` and `USDC` have several crypto rows
 * apiece. Resolving one by symbol is a guess, and since `findBySymbol`
 * tie-breaks on `desc(createdAt)` it is a guess that reliably prefers the
 * newest row: a memecoin minted last month beats the fiat currency of the
 * same ticker every time (SC-223).
 *
 * `Token` satisfies this structurally, so every caller that already holds
 * one passes it unchanged. That is the point — the ids were always in hand
 * and were being discarded one frame before the converter needed them.
 */
export interface CurrencyRef {
  id: string;
  symbol: string;
}

/**
 * Fiat currency conversion with an in-memory rate cache, a DB-backed
 * historical lookup, and exchangerate-api.com as the upstream of last
 * resort. Forex-pair backfill (cron) goes through Frankfurter; this is
 * the synchronous request-time path.
 *
 * DB lookup is delegated to `PriceGraphService` so the same direct +
 * inverse + one-hop routing the historical-chart path uses is also
 * available here. That's what fixes the "switched to EUR, everything
 * shows zero" failure mode: forex-backfill only stores
 * `(EUR → USD = 1.08)` rows, never `(USD → EUR)`. The historical
 * path inverted automatically; this path didn't, so cross-base
 * conversions on a cold exchangerate-api fell off a cliff. Now both
 * paths share the same graph.
 */
@Service()
export class CurrencyConverter {
  private readonly CURRENCY_CONVERSION_TTL_MS = 10 * 60 * 1000;
  // Don't use a DB-resolved rate older than this for a live valuation.
  // Forex moves ~10–15 bp/day on majors; 24 h is the tolerance we
  // already accepted before delegating to PriceGraphService, kept here
  // so the live API still gets a chance to refresh a stale row.
  private readonly DB_RATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  private readonly limiterRegistry = Container.get(OutflowRateLimiterRegistry);
  private readonly exchangeRateLimiter = this.limiterRegistry.get(EXCHANGERATE_LIMIT);

  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly priceGraphService = Container.get(PriceGraphService);

  private readonly currencyRateCache = new Map<
    string,
    { rate: string; expiresAt: number; asOf: number }
  >();

  /**
   * Convert a price between fiat currencies. Returns `null` when the
   * pair has no resolvable rate — either we were asked to stay cache-only
   * and nothing was cached, or the upstream call genuinely failed.
   *
   * IMPORTANT: callers MUST handle `null` explicitly. Coercing it to
   * `'0'` at the call site is the bug that silently zeroed every
   * dashboard after a base-currency switch. The right thing to do with
   * `null` depends on the caller: skip the holding from a sum, display
   * the value in its un-converted currency with a UI marker, or
   * surface an error.
   */
  async convert(
    price: string,
    fromCurrency: CurrencyRef,
    toCurrency: CurrencyRef,
    timestamp: Date,
    cacheOnly = false
  ): Promise<string | null> {
    if (fromCurrency.id === toCurrency.id || price === '0') {
      return price;
    }

    try {
      const rate = await this.getRate(fromCurrency, toCurrency, timestamp, cacheOnly);
      if (rate === null) return null;

      const converted = new Decimal(price).mul(new Decimal(rate));
      logger.debug(
        {
          originalPrice: price,
          rate,
          convertedPrice: converted.toString(),
          fromCurrency: fromCurrency.symbol,
          toCurrency: toCurrency.symbol,
        },
        'Price converted'
      );
      return converted.toString();
    } catch (error) {
      logger.error(
        { error, price, fromCurrency: fromCurrency.symbol, toCurrency: toCurrency.symbol },
        'Price conversion failed'
      );
      return null;
    }
  }

  /**
   * Fetch the conversion rate from fromCurrency → toCurrency at the
   * given timestamp. Returns `null` when no rate can be resolved (same
   * contract as `convert()` — see its doc-comment).
   */
  async getRate(
    fromCurrency: CurrencyRef,
    toCurrency: CurrencyRef,
    timestamp: Date,
    cacheOnly = false
  ): Promise<string | null> {
    const detail = await this.getRateDetail(fromCurrency, toCurrency, timestamp, cacheOnly);
    return detail?.rate ?? null;
  }

  /**
   * `getRate` plus the moment the rate is actually *from* — the timestamp
   * of the price-graph edge it resolved through, or now for a live
   * upstream fetch. Same null contract as `getRate`.
   *
   * A converted figure is a different claim from a same-currency one, so
   * a surface that prints one has to be able to say how old the rate
   * behind it is. This is the only way to get that out of the pipeline
   * without a second rate path alongside the one every valuation uses.
   */
  async getRateDetail(
    fromCurrency: CurrencyRef,
    toCurrency: CurrencyRef,
    timestamp: Date,
    cacheOnly = false
  ): Promise<{ rate: string; asOf: Date } | null> {
    if (fromCurrency.id === toCurrency.id) return { rate: '1', asOf: timestamp };

    const cacheKey = this.cacheKey(fromCurrency, toCurrency);
    const now = Date.now();

    // A cached entry is only usable here if the RATE it holds is inside the
    // valuation tolerance, not merely inside the cache TTL. `getStoredRateDetail`
    // populates the same map with deliberately older rates (SC-222), and a
    // valuation that read one of those would skip the upstream refresh it is
    // entitled to — the two paths share a cache, not a freshness policy.
    const cached = this.readCache(cacheKey, now, this.DB_RATE_MAX_AGE_MS);
    if (cached) {
      logger.debug(
        { fromCurrency: fromCurrency.symbol, toCurrency: toCurrency.symbol },
        'Using cached currency conversion rate'
      );
      return cached;
    }

    const dbRate = await this.fetchRateFromDatabase(fromCurrency, toCurrency, timestamp);
    if (dbRate) {
      this.currencyRateCache.set(cacheKey, {
        rate: dbRate.rate,
        expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
        asOf: dbRate.asOf.getTime(),
      });
      return dbRate;
    }

    if (cacheOnly) {
      logger.debug(
        { fromCurrency: fromCurrency.symbol, toCurrency: toCurrency.symbol },
        'No cached conversion rate available in cache-only mode'
      );
      return null;
    }

    try {
      const url = `${EXCHANGERATE_BASE_URL}/${fromCurrency.symbol}`;
      const response = await this.exchangeRateFetch(url);

      if (!response.ok) {
        throw new Error(
          `ExchangeRate-API responded with ${response.status}: ${response.statusText}`
        );
      }

      const data = (await response.json()) as { rates: Record<string, number> };
      const rate = data.rates?.[toCurrency.symbol];
      if (!rate) {
        throw new Error(
          `No conversion rate available from ${fromCurrency.symbol} to ${toCurrency.symbol}`
        );
      }

      const rateString = rate.toString();

      logger.debug(
        { fromCurrency: fromCurrency.symbol, toCurrency: toCurrency.symbol, rate, apiUrl: url },
        'Currency conversion rate fetched from external API'
      );

      this.currencyRateCache.set(cacheKey, {
        rate: rateString,
        expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
        asOf: now,
      });

      try {
        await this.tokenPriceRepository.bulkUpsert([
          {
            tokenId: fromCurrency.id,
            baseTokenId: toCurrency.id,
            price: rateString,
            timestamp: new Date(),
            source: 'exchangerate-api',
          },
        ]);

        currencyLogger.debug(
          { fromCurrency: fromCurrency.symbol, toCurrency: toCurrency.symbol, rate: rateString },
          'Stored conversion rate in database'
        );
      } catch (dbError) {
        currencyLogger.warn(
          { dbError, fromCurrency: fromCurrency.symbol, toCurrency: toCurrency.symbol },
          'Failed to store conversion rate in database'
        );
      }

      return { rate: rateString, asOf: new Date(now) };
    } catch (error) {
      logger.warn(
        { fromCurrency: fromCurrency.symbol, toCurrency: toCurrency.symbol, error },
        'Failed to get currency conversion rate'
      );
      return null;
    }
  }

  /**
   * The rate a **user-facing read** is allowed to use: whatever we already
   * have, however old, and never an upstream call (SC-222).
   *
   * Two rules, and both are about the person waiting:
   *
   * 1. **It never fetches.** `exchangeRateFetch` goes through an outflow
   *    limiter of 2 requests per 60 seconds whose `execute` *sleeps* until a
   *    slot frees. That is correct for a nightly job and catastrophic on a
   ***REMOVED***
   ***REMOVED***
   *    worker's job; this returns what is known now and the caller enqueues.
   * 2. **It has no maximum age.** A rate from 30 hours ago is a far better
   *    answer than no rate: the wire carries `asOf`, and every surface that
   *    prints a converted figure already dates a stale one rather than
   *    presenting it as current. Refusing it — which `getRateDetail` does at
   *    24 h, correctly, because it can go and get a better one — would put
   *    "rates unavailable" under a total every night between the moment the
   *    day's rows age out and the moment forex-backfill writes new ones.
   */
  async getStoredRateDetail(
    fromCurrency: CurrencyRef,
    toCurrency: CurrencyRef,
    timestamp: Date
  ): Promise<{ rate: string; asOf: Date } | null> {
    if (fromCurrency.id === toCurrency.id) return { rate: '1', asOf: timestamp };

    const cacheKey = this.cacheKey(fromCurrency, toCurrency);
    const now = Date.now();

    const cached = this.readCache(cacheKey, now, null);
    if (cached) return cached;

    const dbRate = await this.fetchRateFromDatabase(fromCurrency, toCurrency, timestamp, null);
    if (!dbRate) return null;

    this.currencyRateCache.set(cacheKey, {
      rate: dbRate.rate,
      expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
      asOf: dbRate.asOf.getTime(),
    });
    return dbRate;
  }

  /**
   * A cached rate, if there is one and it is fresh enough for the caller.
   * `maxRateAgeMs === null` means any age will do. An entry past its TTL is
   * dropped either way — that is the cache's own bookkeeping, separate from
   * whether the rate inside it is too old to use.
   */
  private readCache(
    cacheKey: string,
    now: number,
    maxRateAgeMs: number | null
  ): { rate: string; asOf: Date } | null {
    const cached = this.currencyRateCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= now) {
      this.currencyRateCache.delete(cacheKey);
      return null;
    }
    if (maxRateAgeMs !== null && now - cached.asOf > maxRateAgeMs) return null;
    return { rate: cached.rate, asOf: new Date(cached.asOf) };
  }

  /**
   * Pre-warm rates for a set of (from, to) pairs. Spawns one parallel
   * `getRate(..., cacheOnly=false)` per pair, so by the time consumers
   * loop their holdings the in-memory cache is hot and each per-holding
   * convert can run with cacheOnly=true (cheap, sync after the warm-up).
   *
   * This is the right hook for callers that need to convert many prices
   * to one base currency — the dashboard pricing path being the obvious
   * one. Without this, a base-currency switch forces dozens of serial
   * exchangerate-api calls on the first dashboard fetch.
   *
   * Returns the set of pairs that could NOT be resolved so callers can
   * decide what to do with the affected holdings (skip from a sum,
   * display in source currency, etc.).
   */
  async prewarmRates(
    pairs: Array<{ from: CurrencyRef; to: CurrencyRef }>,
    timestamp: Date
  ): Promise<Set<string>> {
    const unresolved = new Set<string>();
    const unique = new Map<string, { from: CurrencyRef; to: CurrencyRef }>();
    for (const p of pairs) {
      if (p.from.id === p.to.id) continue;
      unique.set(this.cacheKey(p.from, p.to), p);
    }
    await Promise.all(
      Array.from(unique.values()).map(async ({ from, to }) => {
        const rate = await this.getRate(from, to, timestamp, false);
        if (rate === null) {
          unresolved.add(this.cacheKey(from, to));
        }
      })
    );
    return unresolved;
  }

  async preWarm(): Promise<void> {
    currencyLogger.info(
      { currencies: PREWARM_FIAT_SYMBOLS },
      'Pre-warming currency conversion cache'
    );

    try {
      const fiat = await this.resolvePrewarmFiatTokens();
      const usd = fiat.get('USD');
      if (!usd) {
        currencyLogger.warn('No USD fiat token; skipping currency-conversion pre-warm');
        return;
      }

      const url = `${EXCHANGERATE_BASE_URL}/USD`;
      const response = await this.exchangeRateFetch(url);

      if (response.ok) {
        const data = (await response.json()) as { rates: Record<string, number> };
        const now = Date.now();

        for (const [symbol, token] of fiat) {
          if (token.id === usd.id) continue;

          const rate = data.rates?.[symbol];
          if (rate) {
            this.currencyRateCache.set(this.cacheKey(usd, token), {
              rate: rate.toString(),
              expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
              asOf: now,
            });
            this.currencyRateCache.set(this.cacheKey(token, usd), {
              rate: (1 / rate).toString(),
              expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
              asOf: now,
            });
          }
        }

        currencyLogger.info(
          { cachedPairs: this.currencyRateCache.size },
          'Currency conversion cache pre-warmed successfully'
        );
      }
    } catch (error) {
      currencyLogger.warn(
        { error },
        'Failed to pre-warm currency conversion cache, will fetch on demand'
      );
    }
  }

  private async resolvePrewarmFiatTokens(): Promise<Map<string, CurrencyRef>> {
    const fiatType = await this.tokenTypeRepository.findByCode('fiat');
    if (!fiatType) return new Map();

    const tokens = await this.tokenRepository.findBySymbolTypePairs(
      PREWARM_FIAT_SYMBOLS.map((symbol) => ({ symbol, typeId: fiatType.id }))
    );
    return new Map(tokens.map((token) => [token.symbol, token]));
  }

  getCacheSize(): number {
    return this.currencyRateCache.size;
  }

  // Keyed on token ids, not symbols: two `tokens` rows sharing a ticker are
  // different currencies with different price rows, and a symbol-keyed entry
  // would serve one of them the other's rate (SC-223).
  private cacheKey(fromCurrency: CurrencyRef, toCurrency: CurrencyRef): string {
    return `${fromCurrency.id}->${toCurrency.id}`;
  }

  private exchangeRateFetch(url: string): Promise<Response> {
    return this.exchangeRateLimiter.execute(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), EXCHANGERATE_FETCH_TIMEOUT_MS);
      try {
        return await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /**
   * Resolve a fiat-pair rate from anything already stored in
   * `token_prices`. Delegates to `PriceGraphService` so we get:
   *
   *   1. Direct (A → B) — the simple case.
   *   2. Inverse (B → A) → `1 / price`. This is the case forex-backfill
   *      actually produces: every hub edge is stored as `(<edge> → USD)`,
   *      never `(USD → <edge>)`. The previous unidirectional lookup
   *      always missed and forced a live exchangerate-api call; when
   *      that call was rate-limited or down, the dashboard saw `null`
   *      and degraded to "all prices unavailable".
   *   3. One hop via USD / EUR / USDT — covers cross-fiat (EUR → GBP)
   *      and USDT-quoted crypto when the user's base is anything other
   *      than USD/USDT.
   *
   * Returns `null` when no path exists OR the binding leg of the path
   * is older than `maxAgeMs` relative to `timestamp` — stale enough that
   * we'd rather fall through to the live API than serve it. `null` for
   * `maxAgeMs` disables that check entirely, for the one caller that
   * cannot fall through to anything: a user read (SC-222).
   *
   * It resolves nothing. The two token ids arrive from the caller, which
   * held them already; the pair of `findBySymbol` calls that used to stand
   * here were the whole of SC-223 — an `SOS` conversion addressed the
   * newest `SOS` row, which is a memecoin, and read its price rows.
   */
  private async fetchRateFromDatabase(
    fromCurrency: CurrencyRef,
    toCurrency: CurrencyRef,
    timestamp: Date,
    maxAgeMs: number | null = this.DB_RATE_MAX_AGE_MS
  ): Promise<{ rate: string; asOf: Date } | null> {
    try {
      if (fromCurrency.id === toCurrency.id) return { rate: '1', asOf: timestamp };

      const conversion = await this.priceGraphService.convert(
        new Decimal(1),
        fromCurrency.id,
        toCurrency.id,
        timestamp,
        {
          // forex-backfill writes `granularity: 'daily'` rows; preferring
          // daily here lets PriceGraphService pick the cron-fresh edge
          // over any intraday noise from on-demand caching.
          preferGranularity: 'daily',
          hubs: PRICE_HUBS,
        }
      );

      if (!conversion) return null;

      const priceAge = timestamp.getTime() - conversion.effectiveAt.getTime();
      if (maxAgeMs !== null && priceAge > maxAgeMs) {
        currencyLogger.debug(
          {
            fromCurrency: fromCurrency.symbol,
            toCurrency: toCurrency.symbol,
            priceAge: priceAge / (60 * 60 * 1000),
            path: conversion.path,
          },
          'Conversion rate from price graph is too old'
        );
        return null;
      }

      const rateString = conversion.rate.toString();
      currencyLogger.debug(
        {
          fromCurrency: fromCurrency.symbol,
          toCurrency: toCurrency.symbol,
          rate: rateString,
          path: conversion.path,
          effectiveAt: conversion.effectiveAt,
        },
        'Using conversion rate from price graph'
      );

      return { rate: rateString, asOf: conversion.effectiveAt };
    } catch (error) {
      currencyLogger.warn(
        { error, fromCurrency: fromCurrency.symbol, toCurrency: toCurrency.symbol },
        'Failed to get conversion rate from price graph'
      );
      return null;
    }
  }
}
