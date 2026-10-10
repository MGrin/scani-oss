/**
 * Foundation A3, Task 13: the window the backfill asks a real provider for.
 * Yahoo and CoinGecko are the real providers and only `fetch` is stubbed, so
 * each URL read here is the one that would leave the process.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import type { Token, TokenMetadata } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { CoinGeckoProvider } from '@scani/providers/providers/coingecko';
import { YahooFinanceProvider } from '@scani/providers/providers/yahoo-finance';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HistoricalPriceBackfillService } from '../../../src/services/pricing/HistoricalPriceBackfillService';
import { committedRows, dropPricesOf } from '../../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { makeToken } from '../../../test/helpers/factories-extra';

restoreContainerAfterAll();

const rows = committedRows();
const originalFetch = globalThis.fetch;
let requested: URL[] = [];
const typeIds = new Map<string, string>();

beforeAll(async () => {
  for (const type of await getDb()
    .select({ id: schema.tokenTypes.id, code: schema.tokenTypes.code })
    .from(schema.tokenTypes)) {
    typeIds.set(type.code, type.id);
  }
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  requested = [];
  await dropPricesOf(rows.tokens);
  await rows.drop();
});

function typeId(code: 'fiat' | 'crypto'): string {
  const id = typeIds.get(code);
  if (!id) throw new Error(`the ${code} token type is seeded by migration`);
  return id;
}

/** A committed token whose symbol a provider reads; its own segment keeps it off the catalog's key. */
async function commitToken(symbol: string, code: 'fiat' | 'crypto', metadata?: TokenMetadata) {
  const token = await getDb().transaction((tx) =>
    makeToken(tx, {
      symbol,
      typeId: typeId(code),
      marketSegment: `request-test-${randomUUID()}`,
      ...(metadata ? { providerMetadata: metadata } : {}),
    })
  );
  rows.tokens.push(token.id);
  return token;
}

/** Records every URL and answers it with `answer`. */
function stubFetch(answer: (url: URL) => unknown): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    requested.push(url);
    return new Response(JSON.stringify(answer(url)), { status: 200 });
  }) as unknown as typeof fetch;
}

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

function backfillThrough(provider: object): HistoricalPriceBackfillService {
  const registry = new ProviderRegistry();
  registry.register(provider);
  Container.set(ProviderRegistry, registry);
  return new HistoricalPriceBackfillService();
}

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** A Yahoo `=X` chart holding only the bars inside the window asked, as Yahoo serves it. */
function yahooFxChart(url: URL, bars: ReadonlyArray<{ at: string; close: number }>) {
  const period1 = Number(url.searchParams.get('period1'));
  const period2 = Number(url.searchParams.get('period2'));
  const inside = bars.filter(({ at }) => seconds(at) >= period1 && seconds(at) < period2);
  return {
    chart: {
      result: [
        {
          meta: { exchangeTimezoneName: 'Europe/London' },
          timestamp: inside.map(({ at }) => seconds(at)),
          indicators: { quote: [{ close: inside.map(({ close }) => close) }] },
        },
      ],
    },
  };
}

function storedFor(token: Token) {
  return getDb()
    .select()
    .from(schema.tokenPrices)
    .where(eq(schema.tokenPrices.tokenId, token.id))
    .orderBy(asc(schema.tokenPrices.timestamp));
}

describe('the request a needed day makes of a real provider', () => {
  test('Yahoo: the request for a needed day reaches that day’s close', async () => {
    const currency = await commitToken('RUB', 'fiat');
    const base = await commitToken('USD', 'fiat');
    stubFetch((url) => yahooFxChart(url, []));
    const service = backfillThrough(new YahooFinanceProvider(passthroughLimiter()));

    await service.backfillTokenRange(currency.id, base.id, [new Date('2026-07-14T00:00:00Z')]);

    expect(requested.map((url) => url.searchParams.get('period2'))).toEqual([
      String(seconds('2026-07-15T00:00:00Z')),
    ]);
  });

  test('CoinGecko: the request for a needed day reaches that day’s close', async () => {
    const coin = await commitToken(`TOK${randomUUID().replace(/-/g, '')}`, 'crypto', {
      coingecko: { id: 'request-test-coin' },
    });
    const base = await commitToken('USD', 'fiat');
    stubFetch(() => ({ prices: [] }));
    const service = backfillThrough(new CoinGeckoProvider(passthroughLimiter()));

    await service.backfillTokenRange(coin.id, base.id, [new Date('2026-09-20T00:00:00Z')]);

    expect(
      requested
        .filter((url) => url.pathname.endsWith('/market_chart/range'))
        .map((url) => url.searchParams.get('to'))
    ).toEqual([String(seconds('2026-09-21T00:00:00Z'))]);
  });

  test('Yahoo: the first needed day’s =X bar is in the response window', async () => {
    const currency = await commitToken('RUB', 'fiat');
    const base = await commitToken('USD', 'fiat');
    // Summer time: the bar Yahoo dates 14 July starts at London midnight,
    // 23:00 UTC on the 13th.
    const firstDayBar = '2026-07-13T23:00:00Z';
    stubFetch((url) =>
      yahooFxChart(url, [
        { at: firstDayBar, close: 0.25 },
        { at: '2026-07-14T23:00:00Z', close: 0.5 },
      ])
    );
    const service = backfillThrough(new YahooFinanceProvider(passthroughLimiter()));

    await service.backfillTokenRange(currency.id, base.id, [
      new Date('2026-07-14T00:00:00Z'),
      new Date('2026-07-15T00:00:00Z'),
    ]);

    const [request] = requested;
    expect(Number(request?.searchParams.get('period1'))).toBeLessThanOrEqual(seconds(firstDayBar));
    const stored = await storedFor(currency);
    expect(stored.map((row) => [row.timestamp.toISOString(), row.price, row.granularity])).toEqual([
      ['2026-07-14T23:59:59.999Z', '0.25', 'daily'],
      ['2026-07-15T23:59:59.999Z', '0.5', 'daily'],
    ]);
  });
});
