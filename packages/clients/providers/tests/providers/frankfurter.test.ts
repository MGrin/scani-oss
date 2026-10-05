import { afterEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { restoreContainerAfterAll } from '../../../../business/domain/test/helpers/container';
import { freshExchangeRateApiClient } from '../../../../business/domain/test/helpers/exchangerate-api';
import { makeMockToken } from '../../src/core/testing';
import { FrankfurterProvider } from '../../src/providers/frankfurter';

// The fallback's client is installed in the process-global container; put
// back whatever this file changes (SC-448).
restoreContainerAfterAll();

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

/** A provider whose fallback client has asked nothing. */
function provider(): FrankfurterProvider {
  return new FrankfurterProvider(passthroughLimiter(), freshExchangeRateApiClient());
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Answers Frankfurter with `frankfurter` and exchangerate-api with `usdTable`
 * as its USD table. A host with no answer refuses. Records every URL asked.
 */
function upstreams(answers: {
  frankfurter?: unknown;
  usdTable?: Record<string, number>;
}): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const body = url.startsWith('https://api.exchangerate-api.com/')
      ? answers.usdTable && { base: 'USD', rates: answers.usdTable }
      : answers.frankfurter;
    // 404 rather than a 5xx, which the provider's fetch retries after a backoff.
    return body ? Response.json(body) : new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return requested;
}

const eurToken = makeMockToken({ id: 'eur', symbol: 'EUR', name: 'EUR' });
const usdToken = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });
const jpy = makeMockToken({ id: 'jpy', symbol: 'JPY', name: 'JPY' });
const gbp = makeMockToken({ id: 'gbp', symbol: 'GBP', name: 'GBP' });
const rub = makeMockToken({ id: 'rub', symbol: 'RUB', name: 'RUB' });

describe('FrankfurterProvider', () => {
  test('canPrice gates on supported fiat allowlist', () => {
    const p = provider();
    expect(p.canPrice(makeMockToken({ symbol: 'USD' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ symbol: 'GBP' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ symbol: 'ETB' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ symbol: 'FOK' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ symbol: 'BTC' }))).toBe(false);
    expect(p.canPrice(makeMockToken({ symbol: 'NOPE' }))).toBe(false);
  });

  test('fetchCurrentPrice returns identity quote when from === to', async () => {
    const eur = makeMockToken({ id: 'eur', symbol: 'EUR' });
    const quote = await provider().fetchCurrentPrice(eur, { baseCurrency: eurToken });
    expect(quote?.price).toBe('1');
    expect(quote?.source).toBe('frankfurter_identity');
  });

  test('fetchCurrentPrice returns ECB rate from /latest', async () => {
    const requested = upstreams({
      frankfurter: { base: 'EUR', date: '2024-03-05', rates: { USD: 1.25 } },
    });

    const quote = await provider().fetchCurrentPrice(usdToken, { baseCurrency: eurToken });

    // 1 / 1.25
    expect(quote?.price).toBe('0.8');
    expect(quote?.source).toBe('frankfurter');
    expect(requested[0]).toContain('/latest?from=EUR&to=USD');
  });

  test('fetchCurrentPrice returns null when both currencies fall outside the allowlist', async () => {
    const result = await provider().fetchCurrentPrice(makeMockToken({ symbol: 'NOPE' }), {
      baseCurrency: eurToken,
    });
    expect(result).toBeNull();
  });

  test('fetchCurrentPrice falls back to exchangerate-api for RUB, through the one client', async () => {
    const requested = upstreams({ usdTable: { USD: 1, RUB: 97.25 } });

    const quote = await provider().fetchCurrentPrice(rub, { baseCurrency: usdToken });

    expect(requested).toEqual(['https://api.exchangerate-api.com/v4/latest/USD']);
    expect(quote?.price).toBe('0.01028277634961439588688946015');
    expect(quote?.source).toBe('exchangerate-api');
  });

  // CONTROL
  test('the fallback gives no quote for a currency the USD table does not hold', async () => {
    upstreams({ usdTable: { USD: 1, EUR: 0.8, RUB: 0 } });
    const p = provider();

    expect(await p.fetchCurrentPrice(rub, { baseCurrency: usdToken })).toBeNull();
    expect(
      await p.fetchCurrentPrice(makeMockToken({ id: 'kzt', symbol: 'KZT' }), {
        baseCurrency: usdToken,
      })
    ).toBeNull();
  });

  test('fetchHistoricalPrice returns identity quote when from === to', async () => {
    const eur = makeMockToken({ id: 'eur', symbol: 'EUR' });
    const at = new Date('2024-03-05T00:00:00Z');
    const quote = await provider().fetchHistoricalPrice(eur, at, { baseCurrency: eurToken });
    expect(quote?.price).toBe('1');
    expect(quote?.source).toBe('frankfurter_identity');
  });

  test('fetchHistoricalPrice returns ECB rate from upstream', async () => {
    const requested = upstreams({
      frankfurter: { base: 'EUR', date: '2024-03-05', rates: { USD: 1.25 } },
    });

    const at = new Date('2024-03-05T00:00:00Z');
    const quote = await provider().fetchHistoricalPrice(usdToken, at, { baseCurrency: eurToken });

    expect(quote?.price).toBe('0.8');
    expect(requested[0]).toContain('2024-03-05?from=EUR&to=USD');
  });

  test('fetchHistoricalPrice returns null when target currency unsupported', async () => {
    const noSuch = makeMockToken({ id: 'x', symbol: 'NOPE' });
    const result = await provider().fetchHistoricalPrice(usdToken, new Date(), {
      baseCurrency: noSuch,
    });
    expect(result).toBeNull();
  });
});

/**
 * SC-1565. Frankfurter is asked in EUR, the base the ECB publishes, and the
 * pair is divided here. Asked in another base it serves a table it derived
 * and rounded itself.
 *
 * The fixings are invented, each in units per one EUR: on the 4th 1.2 dollars,
 * 150 yen and 0.75 pounds; on the 5th 1.5 dollars and 200 yen.
 */
describe('FrankfurterProvider asks in EUR and divides', () => {
  const THE_3RD = new Date('2024-03-03T00:00:00Z');
  const THE_4TH = new Date('2024-03-04T00:00:00Z');
  const THE_5TH = new Date('2024-03-05T00:00:00Z');
  const ON_THE_4TH = { USD: 1.2, JPY: 150, GBP: 0.75 };
  const ON_THE_5TH = { USD: 1.5, JPY: 200 };

  test('the host is api.frankfurter.dev/v1', async () => {
    const requested = upstreams({
      frankfurter: { base: 'EUR', date: '2024-03-04', rates: ON_THE_4TH },
    });
    const p = provider();

    await p.fetchCurrentPrice(jpy, { baseCurrency: usdToken });
    await p.fetchHistoricalPrice(jpy, THE_4TH, { baseCurrency: usdToken });
    await p.fetchHistoricalRange(jpy, THE_3RD, THE_5TH, { baseCurrency: usdToken });

    expect(requested).toEqual([
      'https://api.frankfurter.dev/v1/latest?from=EUR&to=JPY,USD',
      'https://api.frankfurter.dev/v1/2024-03-04?from=EUR&to=JPY,USD',
      'https://api.frankfurter.dev/v1/2024-03-03..2024-03-05?from=EUR&to=JPY,USD',
    ]);
  });

  test('EUR in USD is the fixing as sent', async () => {
    const requested = upstreams({
      frankfurter: { base: 'EUR', date: '2024-03-04', rates: { USD: 1.2345 } },
    });

    const quote = await provider().fetchCurrentPrice(eurToken, { baseCurrency: usdToken });

    expect(quote?.price).toBe('1.2345');
    expect(quote?.source).toBe('frankfurter');
    expect(requested[0]).toEndWith('/latest?from=EUR&to=USD');
  });

  test('JPY in USD is USD-per-EUR over JPY-per-EUR: latest', async () => {
    upstreams({ frankfurter: { base: 'EUR', date: '2024-03-04', rates: ON_THE_4TH } });

    const quote = await provider().fetchCurrentPrice(jpy, { baseCurrency: usdToken });

    // 1.2 / 150
    expect(quote?.price).toBe('0.008');
    expect(quote?.source).toBe('frankfurter');
    expect(quote?.timestamp).toEqual(THE_4TH);
  });

  test('JPY in USD is USD-per-EUR over JPY-per-EUR: a day', async () => {
    upstreams({ frankfurter: { base: 'EUR', date: '2024-03-04', rates: ON_THE_4TH } });

    const quote = await provider().fetchHistoricalPrice(jpy, THE_4TH, { baseCurrency: usdToken });

    expect(quote?.price).toBe('0.008');
    expect(quote?.source).toBe('frankfurter_historical');
    expect(quote?.timestamp).toEqual(THE_4TH);
  });

  test('JPY in USD is USD-per-EUR over JPY-per-EUR: a range', async () => {
    upstreams({
      frankfurter: { base: 'EUR', rates: { '2024-03-04': ON_THE_4TH, '2024-03-05': ON_THE_5TH } },
    });

    const quotes = await provider().fetchHistoricalRange(jpy, THE_3RD, THE_5TH, {
      baseCurrency: usdToken,
    });

    // 1.2 / 150, then 1.5 / 200
    expect(
      quotes.map((quote) => [quote.timestamp.toISOString().slice(0, 10), quote.price])
    ).toEqual([
      ['2024-03-04', '0.008'],
      ['2024-03-05', '0.0075'],
    ]);
  });

  test('a pair with neither side EUR or USD', async () => {
    const requested = upstreams({
      frankfurter: { base: 'EUR', date: '2024-03-04', rates: ON_THE_4TH },
    });

    const quote = await provider().fetchHistoricalPrice(gbp, THE_4TH, { baseCurrency: jpy });

    expect(requested).toEqual(['https://api.frankfurter.dev/v1/2024-03-04?from=EUR&to=GBP,JPY']);
    // 150 / 0.75
    expect(quote?.price).toBe('200');
  });

  test('a day missing either currency gives no quote', async () => {
    upstreams({
      frankfurter: {
        base: 'EUR',
        rates: {
          '2024-03-03': { USD: 1.2 },
          '2024-03-04': { JPY: 150 },
          '2024-03-05': ON_THE_5TH,
        },
      },
    });
    const p = provider();

    const quotes = await p.fetchHistoricalRange(jpy, THE_3RD, THE_5TH, { baseCurrency: usdToken });

    expect(quotes.map((quote) => quote.timestamp.toISOString().slice(0, 10))).toEqual([
      '2024-03-05',
    ]);

    for (const rates of [{ USD: 1.2 }, { JPY: 150 }]) {
      upstreams({ frankfurter: { base: 'EUR', date: '2024-03-04', rates } });
      expect(await p.fetchCurrentPrice(jpy, { baseCurrency: usdToken })).toBeNull();
      expect(await p.fetchHistoricalPrice(jpy, THE_4TH, { baseCurrency: usdToken })).toBeNull();
    }
  });

  // CONTROL
  test('a zero or negative rate gives no quote', async () => {
    const p = provider();
    for (const rates of [
      { USD: 1.2, JPY: 0 },
      { USD: 1.2, JPY: -150 },
    ]) {
      upstreams({ frankfurter: { base: 'EUR', date: '2024-03-04', rates } });
      expect(await p.fetchCurrentPrice(jpy, { baseCurrency: usdToken })).toBeNull();
      expect(await p.fetchHistoricalPrice(jpy, THE_4TH, { baseCurrency: usdToken })).toBeNull();
      upstreams({ frankfurter: { base: 'EUR', rates: { '2024-03-04': rates } } });
      expect(
        await p.fetchHistoricalRange(jpy, THE_3RD, THE_5TH, { baseCurrency: usdToken })
      ).toEqual([]);
    }
  });

  test('a table in another base is refused', async () => {
    const p = provider();
    for (const base of ['USD', undefined]) {
      upstreams({ frankfurter: { base, date: '2024-03-04', rates: ON_THE_4TH } });
      expect(await p.fetchCurrentPrice(jpy, { baseCurrency: usdToken })).toBeNull();
      expect(await p.fetchHistoricalPrice(jpy, THE_4TH, { baseCurrency: usdToken })).toBeNull();
      upstreams({ frankfurter: { base, rates: { '2024-03-04': ON_THE_4TH } } });
      expect(
        await p.fetchHistoricalRange(jpy, THE_3RD, THE_5TH, { baseCurrency: usdToken })
      ).toEqual([]);
    }
  });
});
