/**
 * `FrankfurterProvider`: fiat exchange rates from named central banks,
 * through Frankfurter v2 (the ECB's reference rates back to 1999, and the
 * Bank of Russia's official rates for RUB and the currencies the ECB does
 * not publish).
 *
 * Solves the fiat→fiat backfill gap that crypto-only providers
 * (CoinGecko, DeFiLlama) leave open: a user holding EUR/GBP/CHF/JPY
 * on Kraken or IBKR still needs each fiat balance valued in their
 * display base currency for the historical net-worth chart.
 *
 * Every rate comes from `./client`, which names the bank for each pair, keeps
 * each bank's latest table for an hour, owns the limiter, and divides the
 * pair itself. This class maps the client's answers onto quotes:
 *  - A current quote is stamped at its fixing day at 00:00 UTC, with no close
 *    day; the router stores it at the instant asked.
 *  - A day or a range quote is the close of the day its row names, which on a
 *    weekend or holiday is the last fixing before the day asked.
 *  - An ECB rate is `frankfurter`, a Bank of Russia rate `frankfurter-cbr`,
 *    each with `_historical` for a day or a range.
 */

import type { Token } from '@scani/db/schema';
import type { ProviderFactory } from '../../core/boot';
import type { Capability, HistoricalPriceProvider } from '../../core/capabilities';
import type { PriceQuote, ProviderContext } from '../../core/types';
import {
  type FrankfurterClient,
  type FxRate,
  frankfurterClient,
  pricedByFrankfurter,
} from './client';

/** A quote for one fixing: stamped at its day's midnight, a close only when `barDay` says so. */
function quoteOf(
  t: Token,
  ctx: ProviderContext,
  rate: FxRate,
  barDay: string | null,
  source: string
): PriceQuote {
  return {
    tokenId: t.id,
    baseTokenId: ctx.baseCurrency.id,
    price: rate.price,
    timestamp: new Date(`${rate.day}T00:00:00Z`),
    barDay,
    source,
  };
}

export class FrankfurterProvider implements HistoricalPriceProvider {
  readonly providerKey = 'frankfurter';
  readonly capabilities: readonly Capability[] = ['current-price', 'historical-price'];

  constructor(private readonly client: FrankfurterClient) {}

  /**
   * Fiat-only filter — Frankfurter knows nothing about crypto. The
   * synchronous gate spares the orchestrator from queuing requests
   * we'd reject on the response. A pair still needs one bank that
   * publishes both sides; the client answers null when none does.
   */
  canPrice(t: Token): boolean {
    return pricedByFrankfurter(t.symbol);
  }

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
        barDay: null,
      };
    }

    const rate = await this.client.latest(fromSymbol, toSymbol);
    return rate && quoteOf(t, ctx, rate, null, rate.source);
  }

  async fetchHistoricalPrice(t: Token, at: Date, ctx: ProviderContext): Promise<PriceQuote | null> {
    const fromSymbol = t.symbol.toUpperCase();
    const toSymbol = ctx.baseCurrency.symbol.toUpperCase();

    if (!pricedByFrankfurter(fromSymbol)) return null;
    if (!pricedByFrankfurter(toSymbol)) return null;

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
        barDay: null,
      };
    }

    const rate = await this.client.onDay(fromSymbol, toSymbol, at.toISOString().slice(0, 10));
    return rate && quoteOf(t, ctx, rate, rate.day, `${rate.source}_historical`);
  }

  /**
   * Every fixing in the period in one request: a year of per-day calls
   * collapsed into one, the difference between ~36s rate-limited and
   * ~200ms for a full-year backfill. The first row may be the last
   * fixing before `from`; it keeps its own day.
   */
  async fetchHistoricalRange(
    t: Token,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    const fromSymbol = t.symbol.toUpperCase();
    const toSymbol = ctx.baseCurrency.symbol.toUpperCase();
    if (!pricedByFrankfurter(fromSymbol)) return [];
    if (!pricedByFrankfurter(toSymbol)) return [];
    if (fromSymbol === toSymbol) return [];
    if (to.getTime() < from.getTime()) return [];

    const rates = await this.client.range(
      fromSymbol,
      toSymbol,
      from.toISOString().slice(0, 10),
      to.toISOString().slice(0, 10)
    );
    return rates.map((rate) => quoteOf(t, ctx, rate, rate.day, `${rate.source}_historical`));
  }
}

/** Boot factory: the provider over the process's one client, which owns the limiter. */
export const frankfurterFactory: ProviderFactory = async () =>
  new FrankfurterProvider(frankfurterClient());
