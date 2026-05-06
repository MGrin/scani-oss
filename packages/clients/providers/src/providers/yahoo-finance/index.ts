/**
 * `YahooFinanceProvider` — current + historical price coverage that
 * fills two gaps Finnhub and Frankfurter leave open:
 *
 *  1. Non-US-listed equities/ETFs (`.TO`, `.NE`/`.NEO`, `.L`, `.DE`, …).
 *     Finnhub's free tier returns 403 on these; Yahoo serves them
 *     unauthenticated via the public chart endpoint.
 *  2. Frankfurter-unsupported fiat (RUB after 2022, KZT, GEL, AED, …).
 *     Frankfurter returns null for historical lookups outside its
 *     ECB-derived list; Yahoo carries full historical FX-cross daily
 *     bars for any ISO-4217 pair via `<FROM><TO>=X` symbols.
 *
 * The chart endpoint lives at:
 *   https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
 *      ?period1={unix-sec}&period2={unix-sec}&interval=1d
 * and returns one bar per trading day. No auth, no API key, but Yahoo
 * applies a coarse per-IP rate limit; we throttle conservatively.
 *
 * For non-USD-quoted equities we also pull the same-period FX-cross
 * series in a second call and convert close-price × rate inline so the
 * orchestrator never has to know about listing currencies.
 */

import type { Token } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
import type { ProviderFactory } from '../../core/boot';
import type { Capability, HistoricalPriceProvider } from '../../core/capabilities';
import type { PriceQuote, ProviderContext } from '../../core/types';
import { fetchWithTimeout } from '../../core/utils/fetch';
import { resolveYahooStockSymbol, yahooFxPairSymbol } from './symbol';

const YAHOO_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Single-day padding around a target timestamp. Yahoo bars are stamped
// at market-open UTC for the listing's exchange — a ±48h window catches
// the closest bar regardless of weekend/holiday alignment.
const SINGLE_POINT_PADDING_SECS = 48 * 60 * 60;

// User-Agent header — Yahoo serves 401/429 to bare clients.
const USER_AGENT = 'Mozilla/5.0 (compatible; ScaniBot/1.0)';

interface YahooChartBar {
  timeSec: number;
  close: number;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: { currency?: string };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

/**
 * ISO-4217 fiat codes Yahoo reliably carries via `<FROM>USD=X` crosses.
 * Used as a synchronous gate in `canPrice` — a stricter list keeps the
 * dispatcher from queuing requests we'd reject downstream.
 */
const SUPPORTED_FIAT = new Set([
  'AED',
  'AMD',
  'ARS',
  'AUD',
  'AZN',
  'BDT',
  'BGN',
  'BHD',
  'BRL',
  'BYN',
  'CAD',
  'CHF',
  'CLP',
  'CNY',
  'COP',
  'CZK',
  'DKK',
  'EGP',
  'EUR',
  'GBP',
  'GEL',
  'GHS',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'ISK',
  'JOD',
  'JPY',
  'KES',
  'KGS',
  'KRW',
  'KWD',
  'KZT',
  'LBP',
  'LKR',
  'MAD',
  'MNT',
  'MXN',
  'MYR',
  'NGN',
  'NOK',
  'NZD',
  'OMR',
  'PEN',
  'PHP',
  'PKR',
  'PLN',
  'QAR',
  'RON',
  'RUB',
  'SAR',
  'SEK',
  'SGD',
  'THB',
  'TJS',
  'TMT',
  'TND',
  'TRY',
  'TWD',
  'UAH',
  'UZS',
  'VND',
  'ZAR',
]);

export class YahooFinanceProvider implements HistoricalPriceProvider {
  readonly providerKey = 'yahoo-finance';
  readonly capabilities: readonly Capability[] = ['current-price', 'historical-price'];

  private readonly logger: CustomLogger;

  constructor(private readonly limiter: OutflowRateLimiter) {
    this.logger = createComponentLogger('provider:yahoo-finance');
  }

  /**
   * Accept any non-US-listed equity (suffix-detected via Finnhub's
   * shared exchange map), any US-listed equity (Yahoo handles them too,
   * though Finnhub will be tried first by registration order), and any
   * ISO-4217 fiat in our SUPPORTED_FIAT set. Crypto is intentionally
   * left to CoinGecko / DeFiLlama.
   */
  canPrice(t: Token): boolean {
    const sym = (t.symbol ?? '').toUpperCase();
    if (!sym) return false;
    if (SUPPORTED_FIAT.has(sym)) return true;
    // Stock-style symbol: 1-5 chars, optionally followed by .SUFFIX or .CLASS.
    return /^[A-Z]{1,5}([.-][A-Z0-9]{1,4})?$/.test(sym);
  }

  async fetchCurrentPrice(t: Token, ctx: ProviderContext): Promise<PriceQuote | null> {
    return this.fetchAt(t, ctx, ctx.timestamp ?? new Date());
  }

  async fetchHistoricalPrice(t: Token, at: Date, ctx: ProviderContext): Promise<PriceQuote | null> {
    return this.fetchAt(t, ctx, at);
  }

  async fetchHistoricalRange(
    t: Token,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    if (to.getTime() < from.getTime()) return [];
    const baseSymbol = ctx.baseCurrency.symbol.toUpperCase();
    const isFiat = SUPPORTED_FIAT.has(t.symbol.toUpperCase());

    if (isFiat) {
      return this.fetchFiatRange(t, ctx, from, to, baseSymbol);
    }

    // Prefer the Finnhub-style symbol from token metadata when set —
    // it carries the exchange suffix the orchestrator already resolved
    // (e.g. `XEQT.TO` for TSX listings, `BMW.DE` for Xetra). The bare
    // `t.symbol` field strips this suffix during dedup, so falling back
    // to it would query Yahoo for a US-listing look-alike or 404.
    const symbolForYahoo = readFinnhubSymbol(t) ?? t.symbol;
    const resolved = resolveYahooStockSymbol(symbolForYahoo);
    if (!resolved) return [];

    const stockBars = await this.fetchChartRange(resolved.yahooSymbol, from, to);
    if (stockBars.length === 0) return [];

    const fxByDay =
      resolved.currency === baseSymbol
        ? null
        : await this.fetchFxRangeByDay(resolved.currency, baseSymbol, from, to);

    const out: PriceQuote[] = [];
    for (const bar of stockBars) {
      const fx = fxByDay?.get(this.dayKey(bar.timeSec));
      // If we needed an FX rate but couldn't find one for this day,
      // skip the bar rather than emit a stock-currency-denominated row
      // that would break the rollup. The next provider's fallback (or
      // the next-day bar) will fill in.
      if (fxByDay && fx == null) continue;
      const price = fx == null ? bar.close : bar.close * fx;
      out.push(this.toQuote(t, ctx, String(price), new Date(bar.timeSec * 1000), 'historical'));
    }
    return out;
  }

  /**
   * Single-point (current or historical) lookup. Falls back to the
   * range fetcher with a tight ±48h window so the close-price logic
   * stays in one place.
   */
  private async fetchAt(t: Token, ctx: ProviderContext, at: Date): Promise<PriceQuote | null> {
    const targetSec = Math.floor(at.getTime() / 1000);
    const from = new Date((targetSec - SINGLE_POINT_PADDING_SECS) * 1000);
    const to = new Date((targetSec + SINGLE_POINT_PADDING_SECS) * 1000);
    const bars = await this.fetchHistoricalRange(t, from, to, ctx);
    if (bars.length === 0) return null;
    // Pick the bar closest to `at`.
    let closest = bars[0];
    if (!closest) return null;
    let bestDelta = Math.abs(new Date(closest.timestamp).getTime() - at.getTime());
    for (const bar of bars) {
      const delta = Math.abs(new Date(bar.timestamp).getTime() - at.getTime());
      if (delta < bestDelta) {
        closest = bar;
        bestDelta = delta;
      }
    }
    return closest ?? null;
  }

  private async fetchFiatRange(
    t: Token,
    ctx: ProviderContext,
    from: Date,
    to: Date,
    baseSymbol: string
  ): Promise<PriceQuote[]> {
    const fromSym = t.symbol.toUpperCase();
    if (fromSym === baseSymbol) {
      // Identity — let the orchestrator's identity short-circuit handle
      // it; returning an empty range here means nothing to write.
      return [];
    }
    const pair = yahooFxPairSymbol(fromSym, baseSymbol);
    const bars = await this.fetchChartRange(pair, from, to);
    return bars.map((bar) =>
      this.toQuote(t, ctx, String(bar.close), new Date(bar.timeSec * 1000), 'fx_historical')
    );
  }

  private async fetchFxRangeByDay(
    fromSym: string,
    toSym: string,
    from: Date,
    to: Date
  ): Promise<Map<string, number>> {
    const pair = yahooFxPairSymbol(fromSym, toSym);
    const bars = await this.fetchChartRange(pair, from, to);
    const out = new Map<string, number>();
    for (const bar of bars) out.set(this.dayKey(bar.timeSec), bar.close);
    return out;
  }

  private async fetchChartRange(
    yahooSymbol: string,
    from: Date,
    to: Date
  ): Promise<YahooChartBar[]> {
    const period1 = Math.floor(from.getTime() / 1000);
    const period2 = Math.floor(to.getTime() / 1000);
    const url = `${YAHOO_BASE_URL}/${encodeURIComponent(yahooSymbol)}?period1=${period1}&period2=${period2}&interval=1d`;
    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        })
      );
      if (!response.ok) {
        this.logger.warn({ status: response.status, yahooSymbol }, 'Yahoo /chart non-OK');
        return [];
      }
      const data = (await response.json()) as YahooChartResponse;
      const result = data.chart?.result?.[0];
      const timestamps = result?.timestamp;
      const closes = result?.indicators?.quote?.[0]?.close;
      if (!Array.isArray(timestamps) || !Array.isArray(closes)) return [];
      const out: YahooChartBar[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        const close = closes[i];
        if (typeof ts !== 'number' || typeof close !== 'number' || !Number.isFinite(close)) {
          continue;
        }
        out.push({ timeSec: ts, close });
      }
      return out;
    } catch (err) {
      this.logger.debug({ err, yahooSymbol }, 'Yahoo chart fetch failed');
      return [];
    }
  }

  private dayKey(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString().slice(0, 10);
  }

  private toQuote(
    t: Token,
    ctx: ProviderContext,
    price: string,
    timestamp: Date,
    variant: 'historical' | 'fx_historical'
  ): PriceQuote {
    return {
      tokenId: t.id,
      baseTokenId: ctx.baseCurrency.id,
      price,
      timestamp,
      source: `yahoo-finance_${variant}`,
    };
  }
}

export const yahooFinanceFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    // Yahoo's public endpoint tolerates a few req/sec but throttles hard
    // above ~10/sec per IP. 5 req / 1s leaves headroom for the FX-cross
    // companion calls a single stock fetch triggers.
    maxRequests: 5,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'yahoo-finance',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'yahoo-finance',
    limiter,
    registeredFrom: 'providers/yahoo-finance',
    description: 'Yahoo Finance public chart: 5 req / 1s',
  });
  return new YahooFinanceProvider(registered);
};

// Pull the Finnhub-style ticker from token metadata when present —
// it carries the exchange suffix (`.TO`, `.NEO`, `.L`, …) the
// orchestrator already resolved for non-US listings. The bare
// `t.symbol` field strips this suffix during dedup.
function readFinnhubSymbol(t: Token): string | null {
  const meta = t.providerMetadata as { finnhub?: { symbol?: string } } | null;
  const sym = meta?.finnhub?.symbol;
  return typeof sym === 'string' && sym.trim() !== '' ? sym : null;
}
