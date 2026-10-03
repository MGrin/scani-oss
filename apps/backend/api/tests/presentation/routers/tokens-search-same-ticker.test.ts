import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CloudClient } from '@scani/cloud-client';
import { resetCloudClient, setCloudClient } from '@scani/cloud-client/runtime';
import type { DbType } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createTokensRouter } from '../../../src/presentation/routers/tokens';
import { buildAuthedContext } from '../../helpers/test-caller';

// SC-1524: searching "AAPL" offered only "Apple • Robinhood Token" from
// CoinGecko. The merge kept one hit per SYMBOL with CoinGecko first, so the
// Finnhub equity of the same ticker was dropped — a new user picked the only
// row and a broker holding became Cryptocurrency.
//
// The catalogue half is a stand-in that answers with `catalogue`: what is
// under test is the merge of catalogue and provider rows, not the SQL. Tickers
// are unique per run, so the router's process-wide search cache cannot answer
// in place of the stubbed provider.

type Hit = {
  symbol: string;
  name: string;
  type: string;
  currency: string;
  provider: 'coingecko' | 'finnhub';
  providerMetadata: Record<string, unknown>;
};

const run = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const STOCK_TICKER = `S${run}`;
const CRYPTO_TICKER = `C${run}`;
const CACHED_TICKER = `M${run}`;
const MATERIALISED_WRAPPER = `W${run}`;

const coin = (symbol: string, name: string): Hit => ({
  symbol,
  name,
  type: 'Crypto',
  currency: 'USD',
  provider: 'coingecko',
  providerMetadata: { id: `${name.toLowerCase().replace(/\W+/g, '-')}-${run}` },
});
const listing = (symbol: string, name: string, type: 'Equity' | 'ETF'): Hit => ({
  symbol,
  name,
  type,
  currency: 'USD',
  provider: 'finnhub',
  providerMetadata: { searchResult: { symbol, displaySymbol: symbol, description: name } },
});

// CoinGecko is the first enricher data-provider fans out to, so its hits lead.
const UPSTREAM: Record<string, Hit[]> = {
  [STOCK_TICKER]: [
    coin(STOCK_TICKER, 'Apple • Robinhood Token'),
    listing(STOCK_TICKER, 'APPLE INC', 'Equity'),
  ],
  [CRYPTO_TICKER]: [
    coin(CRYPTO_TICKER, 'Bitcoin'),
    listing(CRYPTO_TICKER, 'Grayscale Bitcoin Mini Trust ETF', 'ETF'),
  ],
  [CACHED_TICKER]: [coin(CACHED_TICKER, 'Materialised Coin')],
  [MATERIALISED_WRAPPER]: [
    coin(MATERIALISED_WRAPPER, 'Apple xStock'),
    listing(MATERIALISED_WRAPPER, 'APPLE INC', 'Equity'),
  ],
};

const fakeCloud = {
  tokens: {
    search: { query: async ({ query }: { query: string }) => UPSTREAM[query] ?? [] },
  },
} as unknown as CloudClient;

let catalogue: Array<Record<string, unknown>> = [];
const materialised = (symbol: string, name: string) => ({
  id: crypto.randomUUID(),
  symbol,
  name,
  typeId: crypto.randomUUID(),
  type: 'crypto',
  typeName: 'Cryptocurrency',
  decimals: 8,
  iconUrl: null,
  isActive: true,
  source: 'database' as const,
});

// Every builder step returns the chain; `limit` ends it, as it does in the router.
const chain: Record<string, unknown> = new Proxy(
  {},
  { get: (_, step) => (step === 'limit' ? async () => catalogue : () => chain) }
);
const fakeDb = { select: () => chain } as unknown as DbType;

const user = {
  id: crypto.randomUUID(),
  email: 'sc1524@example.test',
  name: 'sc1524',
} as typeof schema.users.$inferSelect;
const search = (query: string) =>
  createTokensRouter(fakeDb, schema).createCaller(buildAuthedContext(user)).search({ query });
const rows = (results: Awaited<ReturnType<typeof search>>) =>
  results.map((r) => `${r.symbol}|${r.type}|${r.provider ?? r.source}|${r.name}`);

beforeAll(() => setCloudClient(fakeCloud));
afterAll(() => resetCloudClient());

describe('tokens.search keeps a stock beside a crypto wrapper of its ticker (SC-1524)', () => {
  test('the equity is offered, and above the tokenized wrapper', async () => {
    catalogue = [];
    expect(rows(await search(STOCK_TICKER))).toEqual([
      `${STOCK_TICKER}|stock|finnhub|APPLE INC`,
      `${STOCK_TICKER}|crypto|coingecko|Apple • Robinhood Token`,
    ]);
  });

  test('control: a real coin still leads an ETF that borrows its ticker', async () => {
    catalogue = [];
    expect(rows(await search(CRYPTO_TICKER))).toEqual([
      `${CRYPTO_TICKER}|crypto|coingecko|Bitcoin`,
      `${CRYPTO_TICKER}|stock|finnhub|Grayscale Bitcoin Mini Trust ETF`,
    ]);
  });

  test('a materialised wrapper does not hide the equity, nor lead it', async () => {
    catalogue = [materialised(MATERIALISED_WRAPPER, 'Apple xStock')];
    expect(rows(await search(MATERIALISED_WRAPPER))).toEqual([
      `${MATERIALISED_WRAPPER}|stock|finnhub|APPLE INC`,
      `${MATERIALISED_WRAPPER}|crypto|database|Apple xStock`,
    ]);
  });

  test('a token materialised after a cached search is listed once', async () => {
    catalogue = [];
    expect(rows(await search(CACHED_TICKER))).toEqual([
      `${CACHED_TICKER}|crypto|coingecko|Materialised Coin`,
    ]);
    catalogue = [materialised(CACHED_TICKER, 'Materialised Coin')];
    expect(rows(await search(CACHED_TICKER))).toEqual([
      `${CACHED_TICKER}|crypto|database|Materialised Coin`,
    ]);
  });
});
