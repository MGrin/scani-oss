/**
 * The one client of exchangerate-api.com.
 *
 * Every caller asks for the same thing, the USD table, and derives its pair
 * from it. So while the vendor answers it is asked at most once an hour per
 * process, however many currencies are in play, and always under one limiter
 * namespace. A failed ask is not kept, so the next caller asks again.
 *
 * Only USD, never a pair's own base: asked by its own base, a low-value
 * currency comes back rounded to two or three digits (SC-1565).
 */

import { createComponentLogger } from '@scani/logging';
import { type OutflowLimiterConfig, OutflowRateLimiterRegistry } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('provider:exchangerate-api');

/** The vendor's whole budget. Every process that asks takes a slot from this namespace. */
const EXCHANGERATE_API_LIMIT: OutflowLimiterConfig = {
  namespace: 'exchangerate-api',
  maxRequests: 10,
  windowMs: 60_000,
};

const BASE = 'USD';
const USD_TABLE_URL = `https://api.exchangerate-api.com/v4/latest/${BASE}`;
// One bound on the whole ask: the wait for a limiter slot and the request.
const ASK_TIMEOUT_MS = 8_000;
// The vendor refreshes once a day and asks for no more than a request an hour;
// a rate-limited address is refused for twenty minutes.
const TABLE_TTL_MS = 60 * 60 * 1000;

// Clients cannot import `@scani/shared`, and a stored price must not depend on
// which package configured decimal.js first.
const RateDecimal = Decimal.clone({
  defaults: true,
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
});

/** Units of each currency per one of the table's base, as text. */
export type Rates = Readonly<Record<string, string>>;

export interface UsdRateTable {
  rates: Rates;
  fetchedAt: Date;
}

/**
 * A vendor's rates against `base` as a table of text. An entry is kept only
 * when it is a finite number above zero, and a table holding no rate but the
 * base's own is null. `base` is 1 in it whatever the vendor lists for it.
 */
export function rateTable(rates: unknown, base: string): Rates | null {
  if (typeof rates !== 'object' || rates === null) return null;
  const table: Record<string, string> = Object.create(null);
  for (const [symbol, rate] of Object.entries(rates)) {
    if (symbol === base) continue;
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) table[symbol] = String(rate);
  }
  if (Object.keys(table).length === 0) return null;
  table[base] = '1';
  return table;
}

/**
 * Price of one `from` in `to`, both against the same table; null when either
 * is missing or not positive. Symbols are matched in upper case.
 */
export function rateBetween(rates: Rates, from: string, to: string): string | null {
  const fromPerBase = positiveRate(rates[from.toUpperCase()]);
  const toPerBase = positiveRate(rates[to.toUpperCase()]);
  if (fromPerBase === null || toPerBase === null) return null;
  return toPerBase.div(fromPerBase).toString();
}

function positiveRate(text: string | undefined): Decimal | null {
  if (text === undefined) return null;
  let rate: Decimal;
  try {
    rate = new RateDecimal(text);
  } catch {
    return null;
  }
  return rate.isFinite() && rate.gt(0) ? rate : null;
}

@Service()
export class ExchangeRateApiClient {
  private readonly limiter = Container.get(OutflowRateLimiterRegistry).get(EXCHANGERATE_API_LIMIT);

  private kept: UsdRateTable | null = null;
  private inFlight: Promise<UsdRateTable | null> | null = null;

  /**
   * Every currency against USD, or null when the upstream did not answer.
   *
   * A success is kept for an hour. A failure is not kept: a cached failure
   * decides the outcome for every caller behind it until it expires (SC-847).
   */
  async fetchUsdRates(): Promise<UsdRateTable | null> {
    if (this.kept && Date.now() - this.kept.fetchedAt.getTime() < TABLE_TTL_MS) {
      return this.kept;
    }
    // Callers that arrive while the table is on its way wait for that request.
    this.inFlight ??= this.request().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async request(): Promise<UsdRateTable | null> {
    const signal = AbortSignal.timeout(ASK_TIMEOUT_MS);
    try {
      const response = await this.limiter.execute(
        () => fetch(USD_TABLE_URL, { signal }),
        undefined,
        signal
      );
      if (!response.ok) {
        logger.warn({ status: response.status }, 'exchangerate-api refused the USD table');
        return null;
      }
      const body = (await response.json()) as { base?: unknown; rates?: unknown };
      if (body.base !== BASE) {
        logger.warn({ base: body.base }, 'exchangerate-api answered in another base');
        return null;
      }
      const rates = rateTable(body.rates, BASE);
      if (rates === null) {
        logger.warn('exchangerate-api answered without a usable rate');
        return null;
      }
      this.kept = { rates, fetchedAt: new Date() };
      return this.kept;
    } catch (err) {
      logger.warn({ err }, 'exchangerate-api request failed');
      return null;
    }
  }
}

/**
 * The process's one client, for the provider factories. They are plain
 * functions, and the Google Sheets workspace does not depend on typedi.
 */
export function exchangeRateApi(): ExchangeRateApiClient {
  return Container.get(ExchangeRateApiClient);
}
