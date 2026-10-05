/**
 * `FrankfurterProvider` — historical fiat/fiat exchange rates via
 * the free Frankfurter API (ECB reference rates back to 1999).
 *
 * Solves the fiat→fiat backfill gap that crypto-only providers
 * (CoinGecko, DeFiLlama) leave open: a user holding EUR/GBP/CHF/JPY
 * on Kraken or IBKR still needs each fiat balance valued in their
 * display base currency for the historical net-worth chart.
 *
 * Live rates come from `/latest`. A pair the ECB does not publish, or
 * one Frankfurter did not answer, comes from the exchangerate-api client.
 *
 * API: `https://api.frankfurter.dev/v1/{date}?from=EUR&to={CCY}[,{CCY}]`
 *  - Always asked from EUR, the base the ECB publishes, and the pair is
 *    divided here: asked from another base, Frankfurter serves a table
 *    it derived and rounded itself (SC-1565).
 *  - Date format: YYYY-MM-DD.
 *  - Resolves to the previous business day on weekends/holidays;
 *    we preserve the resolved date in `PriceQuote.timestamp` so the
 *    ±24h anchor logic in `BalanceAtTimeService` stays sound.
 *  - No key, no rate limit in practice (the public site requests no
 *    user agent or API key); we still register a conservative
 *    rate-limiter (10 req / 1s) to avoid accidentally hammering ECB.
 */

import type { Token } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
import type { ProviderFactory } from '../../core/boot';
import type { Capability, HistoricalPriceProvider } from '../../core/capabilities';
import type { PriceQuote, ProviderContext } from '../../core/types';
import { fetchWithTimeout } from '../../core/utils/fetch';
import {
  type ExchangeRateApiClient,
  exchangeRateApi,
  rateBetween,
  rateTable,
} from '../exchangerate-api/client';

const API = 'https://api.frankfurter.dev/v1';
const BASE = 'EUR';

interface FrankfurterResponse {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

/** The query that asks EUR for both sides of a pair. EUR itself is never a target. */
function fromEurQuery(fromSymbol: string, toSymbol: string): string {
  const targets = [fromSymbol, toSymbol].filter((symbol) => symbol !== BASE);
  return `from=${BASE}&to=${targets.join(',')}`;
}

/** Price of one `fromSymbol` in `toSymbol` from one day's EUR rates, or null when they do not give one. */
function priceFromEurRates(rates: unknown, fromSymbol: string, toSymbol: string): string | null {
  const table = rateTable(rates, BASE);
  return table && rateBetween(table, fromSymbol, toSymbol);
}

/**
 * Currencies Frankfurter publishes rates for.
 * Source: https://frankfurter.dev/docs/#currencies.
 *
 * Frankfurter's data comes from the ECB; the ECB stopped publishing RUB
 * in 2022 and never carried smaller-economy currencies (KZT, GEL, …).
 * Symbols outside this set fall through to `EXCHANGERATE_FALLBACK_FIAT`
 * and we resolve them via exchangerate-api.com instead.
 */
const SUPPORTED_FIAT = new Set([
  'AUD',
  'BGN',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'ISK',
  'JPY',
  'KRW',
  'MXN',
  'MYR',
  'NOK',
  'NZD',
  'PHP',
  'PLN',
  'RON',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'USD',
  'ZAR',
]);

/**
 * Currencies covered by exchangerate-api.com but NOT by Frankfurter/ECB.
 * Used as a live-rate fallback only — exchangerate-api has no historical
 * endpoint on the free tier, so historical pricing remains Frankfurter-only.
 *
 * Every non-ECB code in the USD table, verified 2026-10-05. Keeping only
 * common currencies here would strand refresh jobs for seeded fiat such as
 * ETB before the client can answer. A missing table entry still gives no price.
 * Source: https://api.exchangerate-api.com/v4/latest/USD
 */
const EXCHANGERATE_FALLBACK_FIAT = new Set([
  'AED',
  'AFN',
  'ALL',
  'AMD',
  'ANG',
  'AOA',
  'ARS',
  'AWG',
  'AZN',
  'BAM',
  'BBD',
  'BDT',
  'BHD',
  'BIF',
  'BMD',
  'BND',
  'BOB',
  'BSD',
  'BTN',
  'BWP',
  'BYN',
  'BZD',
  'CDF',
  'CLF',
  'CLP',
  'CNH',
  'COP',
  'CRC',
  'CUP',
  'CVE',
  'DJF',
  'DOP',
  'DZD',
  'EGP',
  'ERN',
  'ETB',
  'FJD',
  'FKP',
  'FOK',
  'GEL',
  'GGP',
  'GHS',
  'GIP',
  'GMD',
  'GNF',
  'GTQ',
  'GYD',
  'HNL',
  'HRK',
  'HTG',
  'IMP',
  'IQD',
  'IRR',
  'JEP',
  'JMD',
  'JOD',
  'KES',
  'KGS',
  'KHR',
  'KID',
  'KMF',
  'KWD',
  'KYD',
  'KZT',
  'LAK',
  'LBP',
  'LKR',
  'LRD',
  'LSL',
  'LYD',
  'MAD',
  'MDL',
  'MGA',
  'MKD',
  'MMK',
  'MNT',
  'MOP',
  'MRU',
  'MUR',
  'MVR',
  'MWK',
  'MZN',
  'NAD',
  'NGN',
  'NIO',
  'NPR',
  'OMR',
  'PAB',
  'PEN',
  'PGK',
  'PKR',
  'PYG',
  'QAR',
  'RSD',
  'RUB',
  'RWF',
  'SAR',
  'SBD',
  'SCR',
  'SDG',
  'SHP',
  'SLE',
  'SLL',
  'SOS',
  'SRD',
  'SSP',
  'STN',
  'SYP',
  'SZL',
  'TJS',
  'TMT',
  'TND',
  'TOP',
  'TTD',
  'TVD',
  'TWD',
  'TZS',
  'UAH',
  'UGX',
  'UYU',
  'UZS',
  'VES',
  'VND',
  'VUV',
  'WST',
  'XAF',
  'XCD',
  'XCG',
  'XDR',
  'XOF',
  'XPF',
  'YER',
  'ZMW',
  'ZWG',
  'ZWL',
]);

export class FrankfurterProvider implements HistoricalPriceProvider {
  readonly providerKey = 'frankfurter';
  readonly capabilities: readonly Capability[] = ['current-price', 'historical-price'];

  private readonly logger: CustomLogger;

  constructor(
    private readonly limiter: OutflowRateLimiter,
    private readonly exchangeRates: ExchangeRateApiClient
  ) {
    this.logger = createComponentLogger('provider:frankfurter');
  }

  /**
   * Fiat-only filter — Frankfurter knows nothing about crypto. The
   * synchronous gate spares the orchestrator from queuing requests
   * we'd reject on the response. Accepts symbols in either the primary
   * (Frankfurter) or fallback (exchangerate-api) allowlist.
   */
  canPrice(t: Token): boolean {
    const sym = t.symbol.toUpperCase();
    return SUPPORTED_FIAT.has(sym) || EXCHANGERATE_FALLBACK_FIAT.has(sym);
  }

  /**
   * Live fiat→fiat rate. Tries Frankfurter (ECB) first when both
   * currencies are in its allowlist; otherwise (or on Frankfurter miss)
   * falls back to exchangerate-api.com. ECB stopped publishing RUB in
   * 2022, so RUB-denominated holdings would silently zero-out without
   * this fallback.
   */
  async fetchCurrentPrice(t: Token, ctx: ProviderContext): Promise<PriceQuote | null> {
    const fromSymbol = t.symbol.toUpperCase();
    const toSymbol = ctx.baseCurrency.symbol.toUpperCase();

    if (fromSymbol === toSymbol) {
      return {
        tokenId: t.id,
        baseTokenId: ctx.baseCurrency.id,
        price: '1',
        timestamp: ctx.timestamp ?? new Date(),
        source: 'frankfurter_identity',
      };
    }

    const fromInPrimary = SUPPORTED_FIAT.has(fromSymbol);
    const toInPrimary = SUPPORTED_FIAT.has(toSymbol);
    const fromInFallback = EXCHANGERATE_FALLBACK_FIAT.has(fromSymbol);
    const toInFallback = EXCHANGERATE_FALLBACK_FIAT.has(toSymbol);

    if (!fromInPrimary && !fromInFallback) return null;
    if (!toInPrimary && !toInFallback) return null;

    if (fromInPrimary && toInPrimary) {
      const quote = await this.fetchFromFrankfurter(t, ctx, fromSymbol, toSymbol);
      if (quote) return quote;
    }

    return this.fetchFromExchangeRateApi(t, ctx, fromSymbol, toSymbol);
  }

  private async fetchFromFrankfurter(
    t: Token,
    ctx: ProviderContext,
    fromSymbol: string,
    toSymbol: string
  ): Promise<PriceQuote | null> {
    const url = `${API}/latest?${fromEurQuery(fromSymbol, toSymbol)}`;
    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, { headers: { 'Content-Type': 'application/json' } })
      );
      if (!response.ok) return null;
      const data = (await response.json()) as FrankfurterResponse;
      if (data.base !== BASE) return null;
      const price = priceFromEurRates(data.rates, fromSymbol, toSymbol);
      if (price === null) return null;
      const effective = data.date
        ? new Date(`${data.date}T00:00:00Z`)
        : (ctx.timestamp ?? new Date());
      return {
        tokenId: t.id,
        baseTokenId: ctx.baseCurrency.id,
        price,
        timestamp: effective,
        source: 'frankfurter',
      };
    } catch (err) {
      this.logger.debug({ err, fromSymbol, toSymbol }, 'Frankfurter /latest request failed');
      return null;
    }
  }

  private async fetchFromExchangeRateApi(
    t: Token,
    ctx: ProviderContext,
    fromSymbol: string,
    toSymbol: string
  ): Promise<PriceQuote | null> {
    const table = await this.exchangeRates.fetchUsdRates();
    const price = table && rateBetween(table.rates, fromSymbol, toSymbol);
    if (!price) return null;
    return {
      tokenId: t.id,
      baseTokenId: ctx.baseCurrency.id,
      price,
      timestamp: ctx.timestamp ?? new Date(),
      source: 'exchangerate-api',
    };
  }

  async fetchHistoricalPrice(t: Token, at: Date, ctx: ProviderContext): Promise<PriceQuote | null> {
    const fromSymbol = t.symbol.toUpperCase();
    const toSymbol = ctx.baseCurrency.symbol.toUpperCase();

    if (!SUPPORTED_FIAT.has(fromSymbol)) return null;
    if (!SUPPORTED_FIAT.has(toSymbol)) return null;

    // Identity case — same currency, 1:1 at the requested date. We
    // emit a quote here so callers don't have to special-case it
    // upstream and the chart's "every day has a price" invariant
    // holds even when base = held.
    if (fromSymbol === toSymbol) {
      return {
        tokenId: t.id,
        baseTokenId: ctx.baseCurrency.id,
        price: '1',
        timestamp: at,
        source: 'frankfurter_identity',
      };
    }

    const dateStr = at.toISOString().slice(0, 10);
    const url = `${API}/${dateStr}?${fromEurQuery(fromSymbol, toSymbol)}`;

    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, { headers: { 'Content-Type': 'application/json' } })
      );
      if (!response.ok) return null;
      const data = (await response.json()) as FrankfurterResponse;
      if (data.base !== BASE) return null;
      const price = priceFromEurRates(data.rates, fromSymbol, toSymbol);
      if (price === null) return null;

      // Resolved business-day date — may be 1-3 days before `at` on
      // weekends / ECB holidays. The balance-at-time service treats
      // daily prices as anchors within ±24h, so this is correct.
      const effective = data.date ? new Date(`${data.date}T00:00:00Z`) : at;
      return {
        tokenId: t.id,
        baseTokenId: ctx.baseCurrency.id,
        price,
        timestamp: effective,
        source: 'frankfurter_historical',
      };
    } catch (err) {
      // Swallowed — backfill orchestrator logs at the aggregate
      // level and doesn't want per-token noise on transient failures.
      this.logger.debug({ err, fromSymbol, toSymbol, date: dateStr }, 'Frankfurter request failed');
      return null;
    }
  }

  /**
   * Range fetch via Frankfurter's `/{from}..{to}` endpoint — returns
   * every business-day rate in the period in one HTTP call. Collapses
   * a year of per-day calls into one request, which is the difference
   * between ~36s (rate-limited per-day) and ~200ms for a full-year
   * GBP/USD backfill.
   */
  async fetchHistoricalRange(
    t: Token,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    const fromSymbol = t.symbol.toUpperCase();
    const toSymbol = ctx.baseCurrency.symbol.toUpperCase();
    if (!SUPPORTED_FIAT.has(fromSymbol)) return [];
    if (!SUPPORTED_FIAT.has(toSymbol)) return [];
    if (fromSymbol === toSymbol) return [];
    if (to.getTime() < from.getTime()) return [];

    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    const url = `${API}/${fromStr}..${toStr}?${fromEurQuery(fromSymbol, toSymbol)}`;
    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, { headers: { 'Content-Type': 'application/json' } })
      );
      if (!response.ok) return [];
      const data = (await response.json()) as FrankfurterRangeResponse;
      if (data.base !== BASE) return [];
      const rates = data.rates ?? {};
      const out: PriceQuote[] = [];
      for (const [dateStr, ratesAtDay] of Object.entries(rates)) {
        const price = priceFromEurRates(ratesAtDay, fromSymbol, toSymbol);
        if (price === null) continue;
        out.push({
          tokenId: t.id,
          baseTokenId: ctx.baseCurrency.id,
          price,
          timestamp: new Date(`${dateStr}T00:00:00Z`),
          source: 'frankfurter_historical',
        });
      }
      return out;
    } catch (err) {
      this.logger.debug(
        { err, fromSymbol, toSymbol, fromStr, toStr },
        'Frankfurter range request failed'
      );
      return [];
    }
  }
}

interface FrankfurterRangeResponse {
  amount?: number;
  base?: string;
  start_date?: string;
  end_date?: string;
  // Map of YYYY-MM-DD → { CCY: units per one EUR }
  rates?: Record<string, Record<string, number>>;
}

/**
 * Boot factory. Registers the rate-limiter namespace and returns the
 * configured provider.
 */
export const frankfurterFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 10,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'frankfurter',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'frankfurter',
    limiter,
    registeredFrom: 'providers/frankfurter',
    description: 'Frankfurter ECB rates: 10 req / 1s',
  });
  return new FrankfurterProvider(registered, exchangeRateApi());
};
