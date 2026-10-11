/**
 * What `PricingService` reads from `token_prices` around asking a provider
 * (foundation A3, Tasks 5, 8 and 18).
 *
 * `fetchUnlessCurrent`, which the import warm-up and the refresh button take,
 * leaves a token unasked when it has a reading against USD under an hour old
 * or a price a person typed. `getTokenPrices`, the hourly run's call, reads
 * nothing stored before it asks (D-6), and falls back to the last reading in
 * the base it was given only for a token no provider answered.
 *
 * The service reads and writes through the global connection, so every row
 * here is committed and removed after each test.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { NewTokenPrice, Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { CurrentPriceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { and, asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { PricingProviderRouter } from '../../../src/services/pricing/PricingProviderRouter';
import { PricingService } from '../../../src/services/pricing/PricingService';
import { ACTIVE_PRICE_WINDOW_MS } from '../../../src/services/pricing/price-windows';
import { committedRows, dropPricesOf } from '../../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { makeToken } from '../../../test/helpers/factories-extra';

restoreContainerAfterAll();

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const rows = committedRows();
let fiatTypeId: string;

beforeAll(async () => {
  const [fiat] = await getDb()
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'));
  if (!fiat) throw new Error('the fiat token type is seeded by migration');
  fiatTypeId = fiat.id;
});

afterEach(async () => {
  await dropPricesOf(rows.tokens);
  await rows.drop();
});

async function commitToken(kind: 'crypto' | 'fiat' = 'crypto'): Promise<Token> {
  const token = await getDb().transaction((tx) =>
    makeToken(tx, kind === 'fiat' ? { typeId: fiatTypeId } : {})
  );
  rows.tokens.push(token.id);
  return token;
}

async function commitPrices(prices: NewTokenPrice[]): Promise<void> {
  await getDb().insert(schema.tokenPrices).values(prices);
}

function storedFor(tokenId: string, baseTokenId: string) {
  return getDb()
    .select()
    .from(schema.tokenPrices)
    .where(
      and(eq(schema.tokenPrices.tokenId, tokenId), eq(schema.tokenPrices.baseTokenId, baseTokenId))
    )
    .orderBy(asc(schema.tokenPrices.timestamp));
}

/**
 * A `PricingService` whose only provider is CoinGecko in the registry, which
 * records what it was asked and answers every token but the `declined` with
 * 200 stamped at the run's clock. The router does not consult `canPrice`, so a
 * declined token is asked and gets no quote.
 */
function pricingService(declined: readonly string[] = []): {
  service: PricingService;
  asked: string[];
} {
  const asked: string[] = [];
  const coingecko: CurrentPriceProvider = {
    providerKey: 'coingecko',
    capabilities: ['current-price'],
    canPrice: () => true,
    fetchCurrentPrice: async (token, ctx) => {
      asked.push(token.id);
      if (declined.includes(token.id)) return null;
      return {
        tokenId: token.id,
        baseTokenId: ctx.baseCurrency.id,
        price: '200',
        timestamp: ctx.timestamp ?? new Date(),
        source: 'coingecko',
        barDay: null,
      };
    },
  };
  const registry = new ProviderRegistry();
  registry.register(coingecko);
  Container.set(ProviderRegistry, registry);
  Container.set(PricingProviderRouter, new PricingProviderRouter());
  return { service: new PricingService(), asked };
}

/** The fiat USD the migrations seed: what the warm-up and the refresh ask against. */
function usd(): Promise<Token> {
  return new PricingService().baseToken();
}

describe('PricingService.fetchUnlessCurrent, the warm-up and the refresh', () => {
  test('the quarter-hour window re-asks what the previous run fetched; a 15-minute one would skip it (SC-1602)', async () => {
    const token = await commitToken();
    const base = await usd();
    const previousRun = new Date(Date.UTC(2026, 9, 7, 12, 18, 0));
    const thisRun = new Date(previousRun.getTime() + 15 * MINUTE);
    // The previous run's answer, stamped when it arrived, seconds into that run.
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: new Date(previousRun.getTime() + 5_000),
        source: 'coingecko',
      },
    ]);

    const fifteen = pricingService();
    await fifteen.service.fetchUnlessCurrent([token], thisRun, 15 * MINUTE);
    expect(fifteen.asked).toEqual([]);

    const active = pricingService();
    await active.service.fetchUnlessCurrent([token], thisRun, ACTIVE_PRICE_WINDOW_MS);
    expect(active.asked).toEqual([token.id]);
  });

  test('a USD reading stamped one hour before is current: no provider call', async () => {
    const token = await commitToken();
    const base = await usd();
    const run = new Date();
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: new Date(run.getTime() - 60 * MINUTE),
        source: 'coingecko',
      },
    ]);
    const { service, asked } = pricingService();

    await service.fetchUnlessCurrent([token], run);

    expect(asked).toEqual([]);
    expect(await storedFor(token.id, base.id)).toHaveLength(1);
  });

  // The quarter-hour run's cache writes are counted apart from the hourly
  // run's, so its share of SC-1610's writes per day can be read (SC-1610).
  test.each([
    ['the writes the cache made', async () => ['h1', 'h2'], 2],
    ['0 when the cache write fails', async () => Promise.reject(new Error('down')), 0],
  ] as const)('reports %s', async (_, revalueAffected, cacheWrites) => {
    const token = await commitToken();
    const base = await usd();
    const run = new Date();
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: new Date(run.getTime() - 61 * MINUTE),
        source: 'coingecko',
      },
    ]);
    Container.set(HoldingCacheWriter, { revalueAffected } as unknown as HoldingCacheWriter);
    const { service } = pricingService();

    expect(await service.fetchUnlessCurrent([token], run)).toEqual({ asked: 1, cacheWrites });
  });

  test('a USD reading stamped 61 minutes before is fetched, and the answer lands at the run', async () => {
    const token = await commitToken();
    const base = await usd();
    const run = new Date();
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: new Date(run.getTime() - 61 * MINUTE),
        source: 'coingecko',
      },
    ]);
    const { service, asked } = pricingService();

    await service.fetchUnlessCurrent([token], run);

    expect(asked).toEqual([token.id]);
    const stored = await storedFor(token.id, base.id);
    expect(stored.map((r) => r.price)).toEqual(['100', '200']);
    expect(stored[1]?.timestamp.getTime()).toBe(run.getTime());
  });

  test('a price a person typed is current whatever its age, in any base', async () => {
    const typedInUsd = await commitToken();
    const typedElsewhere = await commitToken();
    const marketPriced = await commitToken();
    const base = await usd();
    const other = await commitToken('fiat');
    const run = new Date();
    const monthAgo = new Date(run.getTime() - 30 * DAY);
    await commitPrices([
      {
        tokenId: typedInUsd.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: monthAgo,
        source: 'manual',
      },
      {
        tokenId: typedElsewhere.id,
        baseTokenId: other.id,
        price: '100',
        timestamp: monthAgo,
        source: 'manual',
      },
      // CONTROL: the same age from a provider is not current, so the provider was reachable.
      {
        tokenId: marketPriced.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: monthAgo,
        source: 'coingecko',
      },
    ]);
    const { service, asked } = pricingService();

    await service.fetchUnlessCurrent([typedInUsd, typedElsewhere, marketPriced], run);

    expect(asked).toEqual([marketPriced.id]);
  });

  test('a fresh provider reading in another base is not current: the provider is asked against USD', async () => {
    const token = await commitToken();
    const base = await usd();
    const other = await commitToken('fiat');
    const run = new Date();
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: other.id,
        price: '100',
        timestamp: new Date(run.getTime() - 10 * MINUTE),
        source: 'coingecko',
      },
    ]);
    const { service, asked } = pricingService();

    await service.fetchUnlessCurrent([token], run);

    expect(asked).toEqual([token.id]);
    expect((await storedFor(token.id, base.id)).map((r) => r.price)).toEqual(['200']);
  });

  test('USD itself is never asked', async () => {
    const base = await usd();
    const { service, asked } = pricingService();

    await service.fetchUnlessCurrent([base], new Date());

    expect(asked).toEqual([]);
  });
});

// The hourly run's call: nothing stored is read before the fetch.
describe('PricingService.getTokenPrices', () => {
  test('a row stamped one minute before the run is not read: the provider is asked', async () => {
    const token = await commitToken();
    const base = await commitToken('fiat');
    const run = new Date();
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: new Date(run.getTime() - MINUTE),
        source: 'coingecko',
      },
    ]);
    const { service, asked } = pricingService();

    const prices = await service.getTokenPrices([token], base, run);

    expect(prices.get(token.id)).toBe('200');
    expect(asked).toEqual([token.id]);
    const stored = await storedFor(token.id, base.id);
    expect(stored.map((r) => r.price)).toEqual(['100', '200']);
    expect(stored[1]?.timestamp.getTime()).toBe(run.getTime());
  });

  test('a manual row is not read either', async () => {
    const token = await commitToken();
    const base = await commitToken('fiat');
    const run = new Date();
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: new Date(run.getTime() - 30 * DAY),
        source: 'manual',
      },
    ]);
    const { service, asked } = pricingService();

    const prices = await service.getTokenPrices([token], base, run);

    expect(prices.get(token.id)).toBe('200');
    expect(asked).toEqual([token.id]);
  });

  test('a token no provider answers keeps its last reading in the base, and nothing is written', async () => {
    const answered = await commitToken();
    const lastRead = await commitToken();
    const typed = await commitToken();
    const elsewhere = await commitToken();
    const base = await commitToken('fiat');
    const other = await commitToken('fiat');
    const run = new Date();
    const dayAgo = new Date(run.getTime() - DAY);
    await commitPrices([
      {
        tokenId: lastRead.id,
        baseTokenId: base.id,
        price: '90',
        timestamp: dayAgo,
        source: 'coingecko',
      },
      // A person's price does not stand in for a provider's reading.
      { tokenId: typed.id, baseTokenId: base.id, price: '80', timestamp: dayAgo, source: 'manual' },
      // Nor does a reading in another base: nothing converts it.
      {
        tokenId: elsewhere.id,
        baseTokenId: other.id,
        price: '70',
        timestamp: dayAgo,
        source: 'coingecko',
      },
    ]);
    const { service, asked } = pricingService([lastRead.id, typed.id, elsewhere.id]);

    const prices = await service.getTokenPrices([answered, lastRead, typed, elsewhere], base, run);

    expect(Object.fromEntries(prices)).toEqual({ [answered.id]: '200', [lastRead.id]: '90' });
    // CONTROL: every token was asked; the three with no answer twice, by the retry pass.
    const unanswered = [lastRead, typed, elsewhere].flatMap((t) => [t.id, t.id]);
    expect([...asked].sort()).toEqual([answered.id, ...unanswered].sort());
    expect((await storedFor(lastRead.id, base.id)).map((r) => r.price)).toEqual(['90']);
  });

  test('a fresh row in another base is not converted: the provider is asked in the base given', async () => {
    const token = await commitToken();
    const requested = await commitToken('fiat');
    const other = await commitToken('fiat');
    const run = new Date();
    const tenMinutesAgo = new Date(run.getTime() - 10 * MINUTE);
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: other.id,
        price: '100',
        timestamp: tenMinutesAgo,
        source: 'coingecko',
      },
      // The rate a conversion would read, so 300 would be the converted answer.
      {
        tokenId: other.id,
        baseTokenId: requested.id,
        price: '3',
        timestamp: tenMinutesAgo,
        source: 'frankfurter',
      },
    ]);
    const { service, asked } = pricingService();

    const prices = await service.getTokenPrices([token], requested, run);

    expect(prices.get(token.id)).toBe('200');
    expect(asked).toEqual([token.id]);
    expect((await storedFor(token.id, requested.id)).map((r) => r.price)).toEqual(['200']);
  });
});
