import { afterEach, describe, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '../../../../business/domain/test/helpers/container';
import {
  CBR_TABLE_URL,
  ECB_TABLE_URL,
  fixing,
  outsideFrankfurterV2,
} from '../../../../business/domain/test/helpers/frankfurter';
import { freshFrankfurterClient } from '../../../../business/domain/test/helpers/frankfurter-client';
import { makeMockToken } from '../../src/core/testing';
import { FrankfurterProvider } from '../../src/providers/frankfurter';

// The client is installed in the process-global container; put back whatever
// this file changes (SC-448).
restoreContainerAfterAll();

/** A provider whose client has asked nothing. */
function provider(): FrankfurterProvider {
  return new FrankfurterProvider(freshFrankfurterClient());
}

const realFetch = globalThis.fetch;
let requested: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  // R25-6, R25-7: nothing this file asks leaves Frankfurter v2's named tables.
  expect(outsideFrankfurterV2(requested)).toEqual([]);
  requested = [];
});

/**
 * Answers the ECB's table with `ecb` and the CBR's with `cbr`. A bank with no
 * answer refuses. Records every URL asked.
 */
function upstreams(answers: { ecb?: unknown; cbr?: unknown }): string[] {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const body = url.includes('/providers/cbr/') ? answers.cbr : answers.ecb;
    return body ? Response.json(body) : new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return requested;
}

const eurToken = makeMockToken({ id: 'eur', symbol: 'EUR', name: 'EUR' });
const usdToken = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });
const jpy = makeMockToken({ id: 'jpy', symbol: 'JPY', name: 'JPY' });
const gbp = makeMockToken({ id: 'gbp', symbol: 'GBP', name: 'GBP' });
const rub = makeMockToken({ id: 'rub', symbol: 'RUB', name: 'RUB' });

/** Invented: units of each currency per one USD, from the CBR's table. */
const CBR_RATES = { RUB: 97.25, EUR: 0.5 };

describe('FrankfurterProvider', () => {
  test('canPrice: a currency in the ECB’s or the CBR’s table, and nothing else', () => {
    const p = provider();
    for (const symbol of ['USD', 'GBP', 'EUR', 'RUB', 'KZT', 'ETB', 'gbp']) {
      expect(p.canPrice(makeMockToken({ symbol }))).toBe(true);
    }
    // BGN left the ECB's table with Bulgaria's euro; SOS, TWD and FOK are in
    // neither table; the metals and the SDR are not routed.
    for (const symbol of ['BGN', 'SOS', 'TWD', 'FOK', 'XAU', 'XDR', 'BTC', 'NOPE']) {
      expect(p.canPrice(makeMockToken({ symbol }))).toBe(false);
    }
  });

  // Each test that expects no request still installs a refusing upstream, so a
  // regression is a recorded request rather than a call to the real API.
  test('fetchCurrentPrice returns identity quote when from === to', async () => {
    upstreams({});
    const eur = makeMockToken({ id: 'eur', symbol: 'EUR' });
    const quote = await provider().fetchCurrentPrice(eur, { baseCurrency: eurToken });
    expect(quote?.price).toBe('1');
    expect(quote?.source).toBe('frankfurter_identity');
    expect(requested).toEqual([]);
  });

  test('fetchCurrentPrice returns the ECB rate from the ECB table', async () => {
    upstreams({ ecb: fixing('EUR', '2024-03-05', { USD: 1.25 }) });

    const quote = await provider().fetchCurrentPrice(usdToken, { baseCurrency: eurToken });

    // 1 / 1.25
    expect(quote?.price).toBe('0.8');
    expect(quote?.source).toBe('frankfurter');
    expect(requested).toEqual([ECB_TABLE_URL]);
  });

  test('fetchCurrentPrice returns null when both currencies fall outside the tables', async () => {
    upstreams({});
    const result = await provider().fetchCurrentPrice(makeMockToken({ symbol: 'NOPE' }), {
      baseCurrency: eurToken,
    });
    expect(result).toBeNull();
    expect(requested).toEqual([]);
  });

  test('RUB in USD is asked as providers/cbr base=USD and inverted with full digits', async () => {
    upstreams({ cbr: fixing('USD', '2024-03-05', CBR_RATES) });

    const quote = await provider().fetchCurrentPrice(rub, { baseCurrency: usdToken });

    expect(requested).toEqual([CBR_TABLE_URL]);
    // 1 / 97.25 at 28 significant digits.
    expect(quote?.price).toBe('0.01028277634961439588688946015');
    expect(quote?.source).toBe('frankfurter-cbr');
    expect(quote?.barDay).toBeNull();
  });

  test('EUR in RUB is priced from the CBR table only', async () => {
    upstreams({
      ecb: fixing('EUR', '2024-03-05', { USD: 1.25 }),
      cbr: fixing('USD', '2024-03-05', CBR_RATES),
    });

    const quote = await provider().fetchCurrentPrice(eurToken, { baseCurrency: rub });

    expect(requested).toEqual([CBR_TABLE_URL]);
    // rate(USD to RUB) / rate(USD to EUR): 97.25 / 0.5.
    expect(quote?.price).toBe('194.5');
    expect(quote?.source).toBe('frankfurter-cbr');
  });

  // CONTROL
  test('a CBR table without RUB, or with a zero rate for it, gives no quote', async () => {
    for (const rates of [{ EUR: 0.5 }, { EUR: 0.5, RUB: 0 }]) {
      upstreams({ cbr: fixing('USD', '2024-03-05', rates) });
      expect(await provider().fetchCurrentPrice(rub, { baseCurrency: usdToken })).toBeNull();
    }
  });

  test('fetchHistoricalPrice returns identity quote when from === to', async () => {
    upstreams({});
    const eur = makeMockToken({ id: 'eur', symbol: 'EUR' });
    const at = new Date('2024-03-05T00:00:00Z');
    const quote = await provider().fetchHistoricalPrice(eur, at, { baseCurrency: eurToken });
    expect(quote?.price).toBe('1');
    expect(quote?.source).toBe('frankfurter_identity');
    expect(requested).toEqual([]);
  });

  test('fetchHistoricalPrice returns the ECB rate from the ECB', async () => {
    upstreams({ ecb: fixing('EUR', '2024-03-05', { USD: 1.25 }) });

    const at = new Date('2024-03-05T00:00:00Z');
    const quote = await provider().fetchHistoricalPrice(usdToken, at, { baseCurrency: eurToken });

    expect(quote?.price).toBe('0.8');
    expect(requested).toEqual([
      'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=USD&date=2024-03-05',
    ]);
  });

  test('fetchHistoricalPrice returns null when target currency unsupported', async () => {
    upstreams({});
    const noSuch = makeMockToken({ id: 'x', symbol: 'NOPE' });
    const result = await provider().fetchHistoricalPrice(usdToken, new Date(), {
      baseCurrency: noSuch,
    });
    expect(result).toBeNull();
    expect(requested).toEqual([]);
  });
});

/**
 * R25-3: a day and a range ask the bank R25-1 names, and each quote is the
 * close of the day its row names, never the day asked. The fixings are
 * invented, in units per one USD.
 */
describe('FrankfurterProvider: Bank of Russia history', () => {
  test('a day ask on a day with no fixing is stored under the response’s date', async () => {
    // Asked for a Sunday; the bank last fixed on the Friday before.
    upstreams({ cbr: fixing('USD', '2024-03-01', CBR_RATES) });

    const quote = await provider().fetchHistoricalPrice(rub, new Date('2024-03-03T00:00:00Z'), {
      baseCurrency: usdToken,
    });

    expect(requested).toEqual([
      'https://api.frankfurter.dev/v2/providers/cbr/rates?base=USD&quotes=RUB&date=2024-03-03',
    ]);
    expect(quote?.price).toBe('0.01028277634961439588688946015');
    expect(quote?.barDay).toBe('2024-03-01');
    expect(quote?.timestamp.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(quote?.source).toBe('frankfurter-cbr_historical');
  });

  test('a range’s carry-in row, dated before the range, keeps its own barDay', async () => {
    upstreams({
      cbr: [
        ...fixing('USD', '2024-03-01', { RUB: 97.25 }),
        ...fixing('USD', '2024-03-04', { RUB: 50 }),
        ...fixing('USD', '2024-03-05', { RUB: 100 }),
      ],
    });

    const quotes = await provider().fetchHistoricalRange(
      rub,
      new Date('2024-03-03T00:00:00Z'),
      new Date('2024-03-05T00:00:00Z'),
      { baseCurrency: usdToken }
    );

    expect(requested).toEqual([
      'https://api.frankfurter.dev/v2/providers/cbr/rates?base=USD&quotes=RUB&from=2024-03-03&to=2024-03-05',
    ]);
    expect(
      quotes.map((quote) => [
        quote.barDay,
        quote.timestamp.toISOString(),
        quote.price,
        quote.source,
      ])
    ).toEqual([
      [
        '2024-03-01',
        '2024-03-01T00:00:00.000Z',
        '0.01028277634961439588688946015',
        'frankfurter-cbr_historical',
      ],
      ['2024-03-04', '2024-03-04T00:00:00.000Z', '0.02', 'frankfurter-cbr_historical'],
      ['2024-03-05', '2024-03-05T00:00:00.000Z', '0.01', 'frankfurter-cbr_historical'],
    ]);
  });
});

/**
 * SC-1565, on v2. An ECB pair is asked from the ECB's own table, base EUR, and
 * the pair is divided here. Asked in another base, Frankfurter serves a table
 * it derived and rounded itself.
 *
 * The fixings are invented, each in units per one EUR: on the 4th 1.2 dollars,
 * 150 yen and 0.75 pounds; on the 5th 1.5 dollars and 200 yen.
 */
describe('FrankfurterProvider asks the ECB in EUR and divides', () => {
  const THE_3RD = new Date('2024-03-03T00:00:00Z');
  const THE_4TH = new Date('2024-03-04T00:00:00Z');
  const THE_5TH = new Date('2024-03-05T00:00:00Z');
  const ON_THE_4TH = { USD: 1.2, JPY: 150, GBP: 0.75 };
  const ON_THE_5TH = { USD: 1.5, JPY: 200 };

  test('every ask is api.frankfurter.dev/v2 and names the ECB', async () => {
    upstreams({ ecb: fixing('EUR', '2024-03-04', ON_THE_4TH) });
    const p = provider();

    await p.fetchCurrentPrice(jpy, { baseCurrency: usdToken });
    await p.fetchHistoricalPrice(jpy, THE_4TH, { baseCurrency: usdToken });
    await p.fetchHistoricalRange(jpy, THE_3RD, THE_5TH, { baseCurrency: usdToken });

    expect(requested).toEqual([
      ECB_TABLE_URL,
      'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=JPY,USD&date=2024-03-04',
      'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=JPY,USD&from=2024-03-03&to=2024-03-05',
    ]);
  });

  test('EUR in USD is the fixing as sent', async () => {
    upstreams({ ecb: fixing('EUR', '2024-03-04', { USD: 1.2345 }) });

    const quote = await provider().fetchCurrentPrice(eurToken, { baseCurrency: usdToken });

    expect(quote?.price).toBe('1.2345');
    expect(quote?.source).toBe('frankfurter');
  });

  test('JPY in USD is USD-per-EUR over JPY-per-EUR: latest', async () => {
    upstreams({ ecb: fixing('EUR', '2024-03-04', ON_THE_4TH) });

    const quote = await provider().fetchCurrentPrice(jpy, { baseCurrency: usdToken });

    // 1.2 / 150
    expect(quote?.price).toBe('0.008');
    expect(quote?.source).toBe('frankfurter');
    expect(quote?.timestamp.toISOString()).toBe(THE_4TH.toISOString());
  });

  test('JPY in USD is USD-per-EUR over JPY-per-EUR: a day', async () => {
    upstreams({ ecb: fixing('EUR', '2024-03-04', ON_THE_4TH) });

    const quote = await provider().fetchHistoricalPrice(jpy, THE_4TH, { baseCurrency: usdToken });

    expect(quote?.price).toBe('0.008');
    expect(quote?.source).toBe('frankfurter_historical');
    expect(quote?.timestamp.toISOString()).toBe(THE_4TH.toISOString());
    expect(quote?.barDay).toBe('2024-03-04');
  });

  test('JPY in USD is USD-per-EUR over JPY-per-EUR: a range', async () => {
    upstreams({
      ecb: [...fixing('EUR', '2024-03-04', ON_THE_4TH), ...fixing('EUR', '2024-03-05', ON_THE_5TH)],
    });

    const quotes = await provider().fetchHistoricalRange(jpy, THE_3RD, THE_5TH, {
      baseCurrency: usdToken,
    });

    // 1.2 / 150, then 1.5 / 200
    expect(quotes.map((quote) => [quote.barDay, quote.price, quote.source])).toEqual([
      ['2024-03-04', '0.008', 'frankfurter_historical'],
      ['2024-03-05', '0.0075', 'frankfurter_historical'],
    ]);
  });

  test('a pair with neither side EUR or USD', async () => {
    upstreams({ ecb: fixing('EUR', '2024-03-04', ON_THE_4TH) });

    const quote = await provider().fetchHistoricalPrice(gbp, THE_4TH, { baseCurrency: jpy });

    expect(requested).toEqual([
      'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=GBP,JPY&date=2024-03-04',
    ]);
    // 150 / 0.75
    expect(quote?.price).toBe('200');
  });

  test('a day missing either currency gives no quote', async () => {
    upstreams({
      ecb: [
        ...fixing('EUR', '2024-03-03', { USD: 1.2 }),
        ...fixing('EUR', '2024-03-04', { JPY: 150 }),
        ...fixing('EUR', '2024-03-05', ON_THE_5TH),
      ],
    });

    const quotes = await provider().fetchHistoricalRange(jpy, THE_3RD, THE_5TH, {
      baseCurrency: usdToken,
    });

    expect(quotes.map((quote) => quote.barDay)).toEqual(['2024-03-05']);

    for (const rates of [{ USD: 1.2 }, { JPY: 150 }]) {
      upstreams({ ecb: fixing('EUR', '2024-03-04', rates) });
      const p = provider();
      expect(await p.fetchCurrentPrice(jpy, { baseCurrency: usdToken })).toBeNull();
      expect(await p.fetchHistoricalPrice(jpy, THE_4TH, { baseCurrency: usdToken })).toBeNull();
    }
  });

  // CONTROL
  test('a zero or negative rate gives no quote', async () => {
    for (const rates of [
      { USD: 1.2, JPY: 0 },
      { USD: 1.2, JPY: -150 },
    ]) {
      upstreams({ ecb: fixing('EUR', '2024-03-04', rates) });
      const p = provider();
      expect(await p.fetchCurrentPrice(jpy, { baseCurrency: usdToken })).toBeNull();
      expect(await p.fetchHistoricalPrice(jpy, THE_4TH, { baseCurrency: usdToken })).toBeNull();
      expect(
        await p.fetchHistoricalRange(jpy, THE_3RD, THE_5TH, { baseCurrency: usdToken })
      ).toEqual([]);
    }
  });

  test('a table in another base is refused', async () => {
    for (const base of ['USD', undefined]) {
      upstreams({
        ecb: fixing('EUR', '2024-03-04', ON_THE_4TH).map((row) => ({ ...row, base })),
      });
      const p = provider();
      expect(await p.fetchCurrentPrice(jpy, { baseCurrency: usdToken })).toBeNull();
      expect(await p.fetchHistoricalPrice(jpy, THE_4TH, { baseCurrency: usdToken })).toBeNull();
      expect(
        await p.fetchHistoricalRange(jpy, THE_3RD, THE_5TH, { baseCurrency: usdToken })
      ).toEqual([]);
    }
  });
});
