/**
 * The one client of Frankfurter v2, and so of every FX rate Scani asks for.
 *
 * Every pair is read inside ONE named central bank's table: the ECB's when it
 * publishes both sides, otherwise the Bank of Russia's when it does. Never the
 * unnamed `/v2/rates` blend, which mixes sources of different dates, and never
 * two banks in one pair: two banks' crosses of one day differ by about a
 * percent.
 *
 * A bank's own figure comes back only in the direction it publishes (the ECB
 * EUR to X, the Bank of Russia X to RUB); any other direction is Frankfurter's
 * cross, rounded to about five digits. So the ECB is asked in EUR, the Bank of
 * Russia in USD, and a pair is divided here, once.
 *
 * Each bank's latest table is kept for an hour per process, so it costs one
 * request an hour whatever the number of currencies. A day or a range is asked
 * every time. A failed ask is never kept.
 */

import { createComponentLogger } from '@scani/logging';
import { type OutflowLimiterConfig, OutflowRateLimiterRegistry } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('provider:frankfurter');

const API = 'https://api.frankfurter.dev/v2';

const FRANKFURTER_LIMIT: OutflowLimiterConfig = {
  namespace: 'frankfurter',
  maxRequests: 10,
  windowMs: 1_000,
};
// One bound on the whole ask: the wait for a limiter slot and the request.
const ASK_TIMEOUT_MS = 8_000;
// Each bank fixes once a day.
const TABLE_TTL_MS = 60 * 60 * 1000;

// Read 2026-10-05 from the ECB's latest table (its fixing of 2026-10-02).
// BGN left it when Bulgaria adopted the euro on 2026-01-01.
const ECB_CURRENCIES: ReadonlySet<string> = new Set([
  'AUD',
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

// Read 2026-10-05 from the Bank of Russia's latest table asked in USD (its
// fixing of 2026-10-02). It also lists four metals (XAG, XAU, XPD, XPT) and the
// IMF's SDR (XDR); they are left out: none is a currency, and nothing routed
// them through Frankfurter before.
const CBR_CURRENCIES: ReadonlySet<string> = new Set([
  'AED',
  'AMD',
  'AUD',
  'AZN',
  'BDT',
  'BHD',
  'BOB',
  'BRL',
  'BYN',
  'CAD',
  'CHF',
  'CNY',
  'CUP',
  'CZK',
  'DKK',
  'DZD',
  'EGP',
  'ETB',
  'EUR',
  'GBP',
  'GEL',
  'HKD',
  'HUF',
  'IDR',
  'INR',
  'IRR',
  'JPY',
  'KGS',
  'KRW',
  'KZT',
  'MDL',
  'MMK',
  'MNT',
  'NGN',
  'NOK',
  'NZD',
  'OMR',
  'PLN',
  'QAR',
  'RON',
  'RSD',
  'RUB',
  'SAR',
  'SEK',
  'SGD',
  'THB',
  'TJS',
  'TMT',
  'TRY',
  'UAH',
  'USD',
  'UZS',
  'VND',
  'ZAR',
]);

/** The central bank whose published table a rate is read from. */
export type FxBank = 'ecb' | 'cbr';

/** One pair's price, read inside one bank's table. */
export interface FxRate {
  /** Units of `to` per one `from`, as decimal text. */
  price: string;
  /** 'YYYY-MM-DD': the fixing the rate is from, as the response dates it. */
  day: string;
  bank: FxBank;
  source: 'frankfurter' | 'frankfurter-cbr';
}

/** The base each bank is asked in. */
const PIVOT: Readonly<Record<FxBank, string>> = { ecb: 'EUR', cbr: 'USD' };
const SOURCE: Readonly<Record<FxBank, FxRate['source']>> = {
  ecb: 'frankfurter',
  cbr: 'frankfurter-cbr',
};

// Clients cannot import `@scani/shared`, and a stored price must not depend on
// which package configured decimal.js first.
const RateDecimal = Decimal.clone({
  defaults: true,
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Units of each currency per one of the bank's pivot, as text, by fixing day. */
type Fixings = ReadonlyMap<string, ReadonlyMap<string, string>>;

interface Pair {
  bank: FxBank;
  from: string;
  to: string;
}

/** Whether either bank's table carries `symbol`. */
export function pricedByFrankfurter(symbol: string): boolean {
  const code = symbol.toUpperCase();
  return ECB_CURRENCIES.has(code) || CBR_CURRENCIES.has(code);
}

/** The one bank that publishes both sides, the ECB first; null when neither does. */
function route(from: string, to: string): Pair | null {
  const pair = { from: from.toUpperCase(), to: to.toUpperCase() };
  if (ECB_CURRENCIES.has(pair.from) && ECB_CURRENCIES.has(pair.to)) return { ...pair, bank: 'ecb' };
  if (CBR_CURRENCIES.has(pair.from) && CBR_CURRENCIES.has(pair.to)) return { ...pair, bank: 'cbr' };
  return null;
}

/** The query naming the pair's sides; the pivot is never a quote. */
function quotesOf({ bank, from, to }: Pair): string {
  const quotes = [...new Set([from, to])].filter((code) => code !== PIVOT[bank]);
  return quotes.length > 0 ? `&quotes=${quotes.join(',')}` : '';
}

/**
 * A response read as fixings. Refused whole when it is not an array of rows,
 * when any row carries another base, or when no row carries a rate that is a
 * finite number above zero; a row with no usable rate is skipped.
 */
function fixingsFrom(body: unknown, pivot: string): Fixings | null {
  if (!Array.isArray(body)) return null;
  const days = new Map<string, Map<string, string>>();
  let usable = false;
  for (const row of body) {
    if (typeof row !== 'object' || row === null) return null;
    const { date, base, quote, rate } = row as Record<string, unknown>;
    if (base !== pivot) return null;
    if (typeof date !== 'string' || !DAY.test(date) || typeof quote !== 'string') continue;
    let day = days.get(date);
    if (!day) {
      day = new Map([[pivot, '1']]);
      days.set(date, day);
    }
    const code = quote.toUpperCase();
    if (code === pivot) continue;
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      day.set(code, String(rate));
      usable = true;
    }
  }
  return usable ? days : null;
}

/** The pair's price on each day of `fixings` that holds both sides, oldest first. */
function ratesIn(fixings: Fixings, pair: Pair): FxRate[] {
  const out: FxRate[] = [];
  for (const day of [...fixings.keys()].sort()) {
    const rates = fixings.get(day);
    const perFrom = rates?.get(pair.from);
    const perTo = rates?.get(pair.to);
    if (perFrom === undefined || perTo === undefined) continue;
    out.push({
      price: new RateDecimal(perTo).div(perFrom).toString(),
      day,
      bank: pair.bank,
      source: SOURCE[pair.bank],
    });
  }
  return out;
}

@Service()
export class FrankfurterClient {
  // The registry, not a limiter: the limiter is taken at each ask, so it is the
  // backend the process has by then rather than the one it had when this was built.
  private readonly limiters = Container.get(OutflowRateLimiterRegistry);

  private readonly kept = new Map<FxBank, { fixings: Fixings; fetchedAt: number }>();
  private readonly inFlight = new Map<FxBank, Promise<Fixings | null>>();

  /** The latest price of one `from` in `to`, from the one bank that publishes both. */
  async latest(from: string, to: string): Promise<FxRate | null> {
    const pair = route(from, to);
    if (!pair) return null;
    const fixings = await this.latestTable(pair.bank);
    return (fixings && ratesIn(fixings, pair).at(-1)) ?? null;
  }

  /** The fixing in force on `day`: the last at or before it, dated as the response dates it. */
  async onDay(from: string, to: string, day: string): Promise<FxRate | null> {
    const pair = route(from, to);
    if (!pair) return null;
    const fixings = await this.ask(pair.bank, `${quotesOf(pair)}&date=${day}`);
    return (fixings && ratesIn(fixings, pair).at(-1)) ?? null;
  }

  /** Every fixing from the last at or before `fromDay` through `toDay`. */
  async range(from: string, to: string, fromDay: string, toDay: string): Promise<FxRate[]> {
    const pair = route(from, to);
    if (!pair) return [];
    const fixings = await this.ask(pair.bank, `${quotesOf(pair)}&from=${fromDay}&to=${toDay}`);
    return fixings ? ratesIn(fixings, pair) : [];
  }

  /**
   * The bank's whole latest table. A success is kept for an hour. A failure is
   * not kept: a cached failure decides the outcome for every caller behind it
   * until it expires (SC-847).
   */
  private latestTable(bank: FxBank): Promise<Fixings | null> {
    const kept = this.kept.get(bank);
    if (kept && Date.now() - kept.fetchedAt < TABLE_TTL_MS) return Promise.resolve(kept.fixings);
    // Callers that arrive while the table is on its way wait for that request.
    let pending = this.inFlight.get(bank);
    if (!pending) {
      pending = this.ask(bank, '')
        .then((fixings) => {
          if (fixings) this.kept.set(bank, { fixings, fetchedAt: Date.now() });
          return fixings;
        })
        .finally(() => {
          this.inFlight.delete(bank);
        });
      this.inFlight.set(bank, pending);
    }
    return pending;
  }

  private async ask(bank: FxBank, query: string): Promise<Fixings | null> {
    const url = `${API}/providers/${bank}/rates?base=${PIVOT[bank]}${query}`;
    const signal = AbortSignal.timeout(ASK_TIMEOUT_MS);
    try {
      const response = await this.limiters
        .get(FRANKFURTER_LIMIT)
        .execute(() => fetch(url, { signal }), undefined, signal);
      if (!response.ok) {
        logger.warn({ status: response.status, bank }, 'Frankfurter refused the ask');
        return null;
      }
      const fixings = fixingsFrom(await response.json(), PIVOT[bank]);
      if (!fixings) logger.warn({ bank }, 'Frankfurter answered without a usable table');
      return fixings;
    } catch (err) {
      logger.warn({ err, bank }, 'Frankfurter request failed');
      return null;
    }
  }
}

/**
 * The process's one client, for the provider factories. They are plain
 * functions, and the Google Sheets workspace does not depend on typedi.
 */
export function frankfurterClient(): FrankfurterClient {
  return Container.get(FrankfurterClient);
}
