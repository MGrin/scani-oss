import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { restoreContainerAfterAll } from '../../../../business/domain/test/helpers/container';
import { fixing } from '../../../../business/domain/test/helpers/frankfurter';
import { RateLimiterRegistry } from '../../src/core/rate-limiter-registry';
import { makeMockToken } from '../../src/core/testing';
import type { PriceQuote } from '../../src/core/types';
import { CoinGeckoProvider } from '../../src/providers/coingecko';
import { DeFiLlamaProvider } from '../../src/providers/defillama';
import { FinnhubProvider } from '../../src/providers/finnhub';
import { type FrankfurterProvider, frankfurterFactory } from '../../src/providers/frankfurter';
import { fetchKrakenHistoricalPrice } from '../../src/providers/kraken/kraken-ohlc';
import { YahooFinanceProvider } from '../../src/providers/yahoo-finance';

restoreContainerAfterAll();
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});
const limiter = { execute: async <T>(fn: () => Promise<T>) => fn() } as OutflowRateLimiter;
const usd = makeMockToken({ id: 'usd', symbol: 'USD' });
const btc = makeMockToken({
  id: 'btc',
  symbol: 'BTC',
  providerMetadata: { coingecko: { id: 'bitcoin' } },
});
const ctx = { baseCurrency: usd };
const start = new Date('2026-01-12T00:00:00Z');
const end = new Date('2026-07-20T00:00:00Z');
const stamp = (date: string) => Date.parse(date) / 1000;
/**
 * Frankfurter as boot builds it, over the file's one client: this file asks it
 * for one latest table only, so nothing it keeps can answer another test.
 */
async function frankfurter(): Promise<FrankfurterProvider> {
  return (await frankfurterFactory({
    redis: null,
    env: {},
    rateLimiterRegistry: new RateLimiterRegistry(),
    reportCredentialStatus: () => {},
  })) as FrankfurterProvider;
}
function mockBody(body: unknown) {
  globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
}
async function fixture(name: string) {
  return Bun.file(new URL(`../fixtures/price-bars/${name}.json`, import.meta.url)).json();
}
function chart(at: string, timeZone: string, price = 100) {
  return {
    chart: {
      result: [
        {
          meta: { exchangeTimezoneName: timeZone, gmtoffset: -14400 },
          timestamp: [stamp(at)],
          indicators: { quote: [{ close: [price] }] },
        },
      ],
      error: null,
    },
  };
}

describe('provider close-day contracts', () => {
  test.each(['jan', 'jul'])(
    'CoinGecko recorded %s midnight points name the preceding day',
    async (season) => {
      const f = await fixture(`coingecko-bitcoin-${season}`);
      mockBody({
        prices: f.bars.map((p: { at: string; price: string }) => [
          Date.parse(p.at),
          Number(p.price),
        ]),
      });
      const quotes = await new CoinGeckoProvider(limiter).fetchHistoricalRange(
        btc,
        start,
        end,
        ctx
      );
      expect(quotes.length).toBe(f.bars.length);
      expect(quotes[0]?.barDay).toBe(season === 'jan' ? '2026-01-11' : '2026-07-12');
    }
  );
  test('CoinGecko hourly points, including midnight, are instants', async () => {
    mockBody({
      prices: [
        [Date.parse('2026-01-12T00:00:00Z'), 100],
        [Date.parse('2026-01-12T01:00:00Z'), 101],
      ],
    });
    const quotes = await new CoinGeckoProvider(limiter).fetchHistoricalRange(
      btc,
      start,
      new Date('2026-01-19T00:00:00Z'),
      ctx
    );
    expect(quotes.map((q) => q.barDay)).toEqual([null, null]);
  });
  test('CoinGecko history asks the next midnight for the needed close day', async () => {
    const f = await fixture('coingecko-jan-history');
    let url = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      url = String(input);
      return Response.json(f.data);
    }) as unknown as typeof fetch;
    const quote = await new CoinGeckoProvider(limiter).fetchHistoricalPrice(
      btc,
      new Date('2026-01-11T00:00:00Z'),
      ctx
    );
    expect(url).toContain('date=12-01-2026');
    expect(quote?.barDay).toBe('2026-01-11');
    expect(quote?.timestamp).toEqual(new Date('2026-01-12T00:00:00Z'));
  });
  test.each(['bitcoin', 'rocket-pool'])(
    'DeFiLlama recorded %s points retain their observed instants and name the preceding day',
    async (symbol) => {
      const f = await fixture(`defillama-${symbol}-jul`);
      const token = makeMockToken({
        symbol: 'TEST',
        providerMetadata: { defillama: { coin: `coingecko:${symbol}` } },
      });
      mockBody({
        coins: {
          [`coingecko:${symbol}`]: {
            confidence: 1,
            prices: f.bars.map((p: { at: string; price: string }) => ({
              timestamp: Date.parse(p.at) / 1000,
              price: Number(p.price),
            })),
          },
        },
      });
      const quotes = await new DeFiLlamaProvider(limiter).fetchHistoricalRange(
        token,
        new Date('2026-07-13T00:00:00Z'),
        end,
        ctx
      );
      expect(quotes.length).toBeGreaterThan(0);
      expect(quotes[0]?.barDay).toBe('2026-07-12');
    }
  );
  test.each([
    ['2026-01-12T00:30:00Z', '2026-01-11'],
    ['2026-01-11T23:30:00Z', '2026-01-11'],
    ['2026-01-12T03:30:00Z', null],
  ])('DeFiLlama historical point at %s names %s', async (at, day) => {
    mockBody({ coins: { 'coingecko:bitcoin': { price: 100, timestamp: stamp(at) } } });
    const quote = await new DeFiLlamaProvider(limiter).fetchHistoricalPrice(btc, start, ctx);
    expect(quote?.barDay).toBe(day);
    expect(quote?.timestamp).toEqual(new Date(at));
  });
  test.each(['jan', 'jul'])(
    'Yahoo recorded %s stock and FX bars name the provider date',
    async (season) => {
      const p = new YahooFinanceProvider(limiter);
      for (const symbol of ['AAPL', 'VOD.L', 'EURUSD=X']) {
        const f = await fixture(`yahoo-${symbol}-${season}`);
        mockBody({
          chart: {
            result: [
              {
                meta: f.meta,
                timestamp: f.bars.map((b: { at: string }) => stamp(b.at)),
                indicators: {
                  quote: [{ close: f.bars.map((b: { price: string }) => Number(b.price)) }],
                },
              },
            ],
          },
        });
        const token = makeMockToken({ symbol: symbol === 'EURUSD=X' ? 'EUR' : symbol });
        const quotes = await p.fetchHistoricalRange(token, start, end, {
          ...ctx,
          baseCurrency: symbol === 'VOD.L' ? makeMockToken({ symbol: 'GBP' }) : usd,
        });
        expect(quotes.length).toBeGreaterThan(0);
        expect(quotes[0]?.barDay).toBe(season === 'jan' ? '2026-01-12' : '2026-07-13');
      }
    }
  );
  test('Yahoo joins a non-USD close with the same London-labelled FX day', async () => {
    globalThis.fetch = (async (input: string | URL | Request) =>
      Response.json(
        String(input).includes('GBPUSD')
          ? chart('2026-07-12T23:00:00Z', 'Europe/London', 2)
          : chart('2026-07-13T07:00:00Z', 'Europe/London', 100)
      )) as unknown as typeof fetch;
    const quotes = await new YahooFinanceProvider(limiter).fetchHistoricalRange(
      makeMockToken({ symbol: 'VOD.L' }),
      start,
      end,
      ctx
    );
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.barDay).toBe('2026-07-13');
    expect(quotes[0]?.price).toBe('200');
  });
  test('Yahoo historical timezone uses the exchange zone, not current offset', async () => {
    mockBody(chart('2026-01-12T04:30:00Z', 'America/New_York'));
    const quotes = await new YahooFinanceProvider(limiter).fetchHistoricalRange(
      makeMockToken({ symbol: 'AAPL' }),
      start,
      end,
      ctx
    );
    expect(quotes[0]?.barDay).toBe('2026-01-11');
  });
  test('Yahoo off-boundary FX timestamp is an instant', async () => {
    mockBody(chart('2026-07-13T03:30:00Z', 'Europe/London'));
    const quotes = await new YahooFinanceProvider(limiter).fetchHistoricalRange(
      makeMockToken({ symbol: 'EUR' }),
      start,
      end,
      ctx
    );
    expect(quotes[0]?.barDay).toBeNull();
  });
  test.each(['2026-07-28T20:00:00Z', '2026-07-28T20:00:02Z'])(
    'Yahoo terminal stock quote at %s names that session',
    async (at) => {
      mockBody(chart(at, 'America/New_York'));
      const quotes = await new YahooFinanceProvider(limiter).fetchHistoricalRange(
        makeMockToken({ symbol: 'AAPL' }),
        start,
        end,
        ctx
      );
      expect(quotes[0]?.barDay).toBe('2026-07-28');
    }
  );
  test('Finnhub documented daily candles name New York dates', async () => {
    const f = await fixture('finnhub-contract');
    mockBody(f.data);
    const quotes = await new FinnhubProvider(limiter, { apiKey: 'test-key' }).fetchHistoricalRange(
      makeMockToken({ symbol: 'AAPL' }),
      new Date('2019-09-24T00:00:00Z'),
      new Date('2019-09-27T00:00:00Z'),
      ctx
    );
    expect(quotes.map((q) => q.barDay)).toEqual(['2019-09-24', '2019-09-25', '2019-09-26']);
  });
  test('Frankfurter historical fixing names the response date, including weekends', async () => {
    mockBody(fixing('EUR', '2026-01-09', { USD: 2 }));
    const q = await (await frankfurter()).fetchHistoricalPrice(
      makeMockToken({ symbol: 'EUR' }),
      start,
      ctx
    );
    expect(q?.barDay).toBe('2026-01-09');
  });
  test('Kraken cached in-progress daily bar is refetched after its day ends', async () => {
    const token = makeMockToken({
      symbol: 'TEST',
      providerMetadata: { kraken: { asset: 'TESTBAR' } },
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({
        error: [],
        result: {
          TESTBARUSD: [
            [stamp('2026-01-12T00:00:00Z'), '100', '100', '100', calls === 1 ? '100' : '200'],
          ],
          last: stamp('2026-01-12T00:00:00Z'),
        },
      });
    }) as unknown as typeof fetch;
    setSystemTime(new Date('2026-01-12T03:00:00Z'));
    const first = await fetchKrakenHistoricalPrice(token, start, ctx);
    expect(first?.barDay).toBe('2026-01-12');
    setSystemTime(new Date('2026-01-13T03:00:00Z'));
    const second = await fetchKrakenHistoricalPrice(token, start, ctx);
    expect(second?.price).toBe('200');
    expect(calls).toBe(2);
    expect((await fetchKrakenHistoricalPrice(token, start, ctx))?.price).toBe('200');
    expect(calls).toBe(2);
  });
  test.each(['coingecko', 'defillama', 'yahoo', 'finnhub', 'frankfurter'])(
    '%s current quote has no close day',
    async (provider) => {
      let q: PriceQuote | null | undefined;
      if (provider === 'coingecko') {
        mockBody({ bitcoin: { usd: 100 } });
        q = await new CoinGeckoProvider(limiter).fetchCurrentPrice(btc, ctx);
      }
      if (provider === 'defillama') {
        mockBody({ coins: { 'coingecko:bitcoin': { price: 100, confidence: 1 } } });
        q = await new DeFiLlamaProvider(limiter).fetchCurrentPrice(btc, ctx);
      }
      if (provider === 'yahoo') {
        mockBody(chart('2026-01-12T14:30:00Z', 'America/New_York'));
        q = await new YahooFinanceProvider(limiter).fetchCurrentPrice(
          makeMockToken({ symbol: 'AAPL' }),
          ctx
        );
      }
      if (provider === 'finnhub') {
        mockBody({ c: 100 });
        q = await new FinnhubProvider(limiter, { apiKey: 'test-key' }).fetchCurrentPrice(
          makeMockToken({ symbol: 'AAPL' }),
          ctx
        );
      }
      if (provider === 'frankfurter') {
        mockBody(fixing('EUR', '2026-01-12', { USD: 2 }));
        q = await (await frankfurter()).fetchCurrentPrice(makeMockToken({ symbol: 'EUR' }), ctx);
      }
      expect(q).not.toBeNull();
      expect(q?.barDay).toBeNull();
    }
  );
});

test('Yahoo current conversion can use an in-progress FX observation without calling it a close', async () => {
  const now = new Date('2026-07-13T15:00:00Z');
  setSystemTime(now);
  globalThis.fetch = (async (input: string | URL | Request) =>
    Response.json(
      String(input).includes('GBPUSD')
        ? chart('2026-07-13T15:00:00Z', 'Europe/London', 2)
        : chart('2026-07-13T07:00:00Z', 'Europe/London', 100)
    )) as unknown as typeof fetch;
  const p = new YahooFinanceProvider(limiter);
  const token = makeMockToken({ symbol: 'VOD.L' });
  const quote = await p.fetchCurrentPrice(token, { ...ctx, timestamp: now });
  expect(quote?.price).toBe('200');
  expect(quote?.barDay).toBeNull();
  const history = await p.fetchHistoricalRange(token, start, end, ctx);
  expect(history).toEqual([]);
});

test('Yahoo never invents a trading date when the exchange timezone is absent', async () => {
  mockBody({
    chart: {
      result: [
        { timestamp: [stamp('2026-01-12T00:30:00Z')], indicators: { quote: [{ close: [100] }] } },
      ],
    },
  });
  const quotes = await new YahooFinanceProvider(limiter).fetchHistoricalRange(
    makeMockToken({ symbol: 'AAPL' }),
    start,
    end,
    ctx
  );
  expect(quotes[0]?.barDay).toBeNull();
});
