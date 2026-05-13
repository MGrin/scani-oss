import { createComponentLogger, logger } from '@scani/logging';
import { OutflowRateLimiterRegistry } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { EXCHANGERATE_LIMIT } from './upstream-rate-limits';

const currencyLogger = createComponentLogger('pricing:currency');

// `https://api.exchangerate-api.com/v4/latest/{base}` — the `/latest/`
// segment is required; the previous `/v4/{base}` form silently 404'd
// in production, leaving every CAD/EUR/GBP/etc. holding stranded with
// price=0 because every conversion call returned `'0'`.
const EXCHANGERATE_BASE_URL = 'https://api.exchangerate-api.com/v4/latest';
const EXCHANGERATE_FETCH_TIMEOUT_MS = 8000;

/**
 * Fiat currency conversion with an in-memory rate cache, a DB-backed
 * historical lookup, and exchangerate-api.com as the upstream of last
 * resort. Forex-pair backfill (cron) goes through Frankfurter; this is
 * the synchronous request-time path.
 */
@Service()
export class CurrencyConverter {
  private readonly CURRENCY_CONVERSION_TTL_MS = 10 * 60 * 1000;

  private readonly limiterRegistry = Container.get(OutflowRateLimiterRegistry);
  private readonly exchangeRateLimiter = this.limiterRegistry.get(EXCHANGERATE_LIMIT);

  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);

  private readonly currencyRateCache = new Map<string, { rate: string; expiresAt: number }>();

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
    fromCurrency: string,
    toCurrency: string,
    timestamp: Date,
    cacheOnly = false
  ): Promise<string | null> {
    if (fromCurrency === toCurrency || price === '0') {
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
          fromCurrency,
          toCurrency,
        },
        'Price converted'
      );
      return converted.toString();
    } catch (error) {
      logger.error({ error, price, fromCurrency, toCurrency }, 'Price conversion failed');
      return null;
    }
  }

  /**
   * Fetch the conversion rate from fromCurrency → toCurrency at the
   * given timestamp. Returns `null` when no rate can be resolved (same
   * contract as `convert()` — see its doc-comment).
   */
  async getRate(
    fromCurrency: string,
    toCurrency: string,
    timestamp: Date,
    cacheOnly = false
  ): Promise<string | null> {
    if (fromCurrency === toCurrency) return '1';

    const cacheKey = this.cacheKey(fromCurrency, toCurrency);
    const cached = this.currencyRateCache.get(cacheKey);
    const now = Date.now();

    if (cached) {
      if (cached.expiresAt > now) {
        logger.debug({ fromCurrency, toCurrency }, 'Using cached currency conversion rate');
        return cached.rate;
      }
      this.currencyRateCache.delete(cacheKey);
    }

    const dbRate = await this.fetchRateFromDatabase(fromCurrency, toCurrency, timestamp);
    if (dbRate) {
      this.currencyRateCache.set(cacheKey, {
        rate: dbRate,
        expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
      });
      return dbRate;
    }

    if (cacheOnly) {
      logger.debug(
        { fromCurrency, toCurrency },
        'No cached conversion rate available in cache-only mode'
      );
      return null;
    }

    try {
      const url = `${EXCHANGERATE_BASE_URL}/${fromCurrency}`;
      const response = await this.exchangeRateFetch(url);

      if (!response.ok) {
        throw new Error(
          `ExchangeRate-API responded with ${response.status}: ${response.statusText}`
        );
      }

      const data = (await response.json()) as { rates: Record<string, number> };
      if (!data.rates?.[toCurrency]) {
        throw new Error(`No conversion rate available from ${fromCurrency} to ${toCurrency}`);
      }

      const rate = data.rates[toCurrency];
      const rateString = rate.toString();

      logger.debug(
        { fromCurrency, toCurrency, rate, apiUrl: url },
        'Currency conversion rate fetched from external API'
      );

      this.currencyRateCache.set(cacheKey, {
        rate: rateString,
        expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
      });

      try {
        const fromToken = await this.tokenRepository.findBySymbol(fromCurrency);
        const toToken = await this.tokenRepository.findBySymbol(toCurrency);

        if (fromToken && toToken) {
          await this.tokenPriceRepository.bulkUpsert([
            {
              tokenId: fromToken.id,
              baseTokenId: toToken.id,
              price: rateString,
              timestamp: new Date(),
              source: 'exchangerate-api',
            },
          ]);

          currencyLogger.debug(
            { fromCurrency, toCurrency, rate: rateString },
            'Stored conversion rate in database'
          );
        }
      } catch (dbError) {
        currencyLogger.warn(
          { dbError, fromCurrency, toCurrency },
          'Failed to store conversion rate in database'
        );
      }

      return rateString;
    } catch (error) {
      logger.warn({ fromCurrency, toCurrency, error }, 'Failed to get currency conversion rate');
      return null;
    }
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
    pairs: Array<{ from: string; to: string }>,
    timestamp: Date
  ): Promise<Set<string>> {
    const unresolved = new Set<string>();
    const unique = new Map<string, { from: string; to: string }>();
    for (const p of pairs) {
      if (p.from === p.to) continue;
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
    const commonCurrencies = ['USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD'];

    currencyLogger.info({ currencies: commonCurrencies }, 'Pre-warming currency conversion cache');

    try {
      const url = `${EXCHANGERATE_BASE_URL}/USD`;
      const response = await this.exchangeRateFetch(url);

      if (response.ok) {
        const data = (await response.json()) as { rates: Record<string, number> };
        const now = Date.now();

        for (const toCurrency of commonCurrencies) {
          if (toCurrency === 'USD') continue;

          const rate = data.rates?.[toCurrency];
          if (rate) {
            this.currencyRateCache.set(this.cacheKey('USD', toCurrency), {
              rate: rate.toString(),
              expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
            });
            this.currencyRateCache.set(this.cacheKey(toCurrency, 'USD'), {
              rate: (1 / rate).toString(),
              expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
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

  getCacheSize(): number {
    return this.currencyRateCache.size;
  }

  private cacheKey(fromCurrency: string, toCurrency: string): string {
    return `${fromCurrency.toUpperCase()}->${toCurrency.toUpperCase()}`;
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

  private async fetchRateFromDatabase(
    fromCurrencySymbol: string,
    toCurrencySymbol: string,
    timestamp: Date
  ): Promise<string | null> {
    try {
      const fromToken = await this.tokenRepository.findBySymbol(fromCurrencySymbol);
      const toToken = await this.tokenRepository.findBySymbol(toCurrencySymbol);

      if (!fromToken || !toToken) return null;

      if (fromToken.id === toToken.id) return '1';

      const priceResult = await this.tokenPriceRepository.findLatestPrice(fromToken.id, toToken.id);

      if (!priceResult || priceResult.price === '0') return null;

      const priceAge = timestamp.getTime() - new Date(priceResult.timestamp).getTime();
      if (priceAge > 24 * 60 * 60 * 1000) {
        currencyLogger.debug(
          {
            fromCurrency: fromCurrencySymbol,
            toCurrency: toCurrencySymbol,
            priceAge: priceAge / (60 * 60 * 1000),
          },
          'Conversion rate from database is too old'
        );
        return null;
      }

      currencyLogger.debug(
        {
          fromCurrency: fromCurrencySymbol,
          toCurrency: toCurrencySymbol,
          rate: priceResult.price,
          source: priceResult.source,
        },
        'Using conversion rate from database'
      );

      return priceResult.price;
    } catch (error) {
      currencyLogger.warn(
        { error, fromCurrencySymbol, toCurrencySymbol },
        'Failed to get conversion rate from database'
      );
      return null;
    }
  }
}
