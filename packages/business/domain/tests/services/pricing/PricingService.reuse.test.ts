/**
 * Characterization (foundation A3, Task 5): the one-hour reuse in
 * `PricingService.getTokenPrices`, the batch path the hourly run and the
 * import warm-up both take, before Tasks 6 to 8 move it. And the single-token
 * path, `getTokenPrice`, which the refresh button and the vault take: a window
 * of an hour either side of the time asked (Task 6, Step 0).
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
import { CurrencyConverter } from '../../../src/services/pricing/CurrencyConverter';
import { PricingProviderRouter } from '../../../src/services/pricing/PricingProviderRouter';
import { PricingService } from '../../../src/services/pricing/PricingService';
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
 * answers every token with 200 stamped at the run's clock and records what it
 * was asked. A fresh converter, so no rate cached by another test is read.
 */
function pricingService(): { service: PricingService; asked: string[] } {
  const asked: string[] = [];
  const coingecko: CurrentPriceProvider = {
    providerKey: 'coingecko',
    capabilities: ['current-price'],
    canPrice: () => true,
    fetchCurrentPrice: async (token, ctx) => {
      asked.push(token.id);
      return {
        tokenId: token.id,
        baseTokenId: ctx.baseCurrency.id,
        price: '200',
        timestamp: ctx.timestamp ?? new Date(),
        source: 'coingecko',
      };
    },
  };
  const registry = new ProviderRegistry();
  registry.register(coingecko);
  Container.set(ProviderRegistry, registry);
  Container.set(PricingProviderRouter, new PricingProviderRouter());
  Container.set(CurrencyConverter, new CurrencyConverter());
  return { service: new PricingService(), asked };
}

describe('PricingService.getTokenPrices one-hour reuse', () => {
  test('a row stamped one hour before the run is reused: no provider call', async () => {
    const token = await commitToken();
    const base = await commitToken('fiat');
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

    const prices = await service.getTokenPrices([token], base, run);

    expect(prices.get(token.id)).toBe('100');
    expect(asked).toEqual([]);
    expect(await storedFor(token.id, base.id)).toHaveLength(1);
  });

  test('a row stamped 61 minutes before the run is fetched', async () => {
    const token = await commitToken();
    const base = await commitToken('fiat');
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

    const prices = await service.getTokenPrices([token], base, run);

    expect(prices.get(token.id)).toBe('200');
    expect(asked).toEqual([token.id]);
    const stored = await storedFor(token.id, base.id);
    expect(stored.map((r) => r.price)).toEqual(['100', '200']);
    expect(stored[1]?.timestamp.getTime()).toBe(run.getTime());
  });

  test('a manual row is reused whatever its age', async () => {
    const manual = await commitToken();
    const marketPriced = await commitToken();
    const base = await commitToken('fiat');
    const run = new Date();
    const monthAgo = new Date(run.getTime() - 30 * DAY);
    await commitPrices([
      {
        tokenId: manual.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: monthAgo,
        source: 'manual',
      },
      // CONTROL: the same age from a provider is not reused, so the provider was reachable.
      {
        tokenId: marketPriced.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: monthAgo,
        source: 'coingecko',
      },
    ]);
    const { service, asked } = pricingService();

    const prices = await service.getTokenPrices([manual, marketPriced], base, run);

    expect(prices.get(manual.id)).toBe('100');
    expect(prices.get(marketPriced.id)).toBe('200');
    expect(asked).toEqual([marketPriced.id]);
    expect(await storedFor(manual.id, base.id)).toHaveLength(1);
  });

  test('a fresh row in another base is converted, and no row is written in the base asked', async () => {
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
      // The rate the converter reads: one unit of `other` is three of
      // `requested`, so the converted 300 is not the provider's 200.
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

    expect(prices.get(token.id)).toBe('300');
    expect(asked).toEqual([]);
    expect(await storedFor(token.id, requested.id)).toHaveLength(0);
    expect(await storedFor(token.id, other.id)).toHaveLength(1);
  });
});

// The time asked sits 90 minutes back, so it is still a live ask (under two
// hours old) and the window is one hour, while an hour after it is still in
// the past and can hold a stored row.
describe('PricingService.getTokenPrice one-hour reuse, either side of the time asked', () => {
  test('a row stamped 59 minutes AFTER the time asked is reused: no provider call', async () => {
    const token = await commitToken();
    const base = await commitToken('fiat');
    const asked = new Date(Date.now() - 90 * MINUTE);
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: new Date(asked.getTime() + 59 * MINUTE),
        source: 'coingecko',
      },
    ]);
    const { service, asked: providerAsked } = pricingService();

    expect(await service.getTokenPrice(token, base, asked)).toBe('100');
    expect(providerAsked).toEqual([]);
    expect(await storedFor(token.id, base.id)).toHaveLength(1);
  });

  test('a row stamped exactly an hour before the time asked is reused', async () => {
    const token = await commitToken();
    const base = await commitToken('fiat');
    const asked = new Date(Date.now() - 90 * MINUTE);
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: new Date(asked.getTime() - 60 * MINUTE),
        source: 'coingecko',
      },
    ]);
    const { service, asked: providerAsked } = pricingService();

    expect(await service.getTokenPrice(token, base, asked)).toBe('100');
    expect(providerAsked).toEqual([]);
  });

  test('of two rows in the window, the nearer one answers, even when it is after the time asked', async () => {
    const token = await commitToken();
    const base = await commitToken('fiat');
    const asked = new Date(Date.now() - 90 * MINUTE);
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: new Date(asked.getTime() - 50 * MINUTE),
        source: 'coingecko',
      },
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '110',
        timestamp: new Date(asked.getTime() + 10 * MINUTE),
        source: 'coingecko',
      },
    ]);
    const { service, asked: providerAsked } = pricingService();

    expect(await service.getTokenPrice(token, base, asked)).toBe('110');
    expect(providerAsked).toEqual([]);
  });

  test('CONTROL: a row stamped 61 minutes after the time asked is not reused: the provider is asked', async () => {
    const token = await commitToken();
    const base = await commitToken('fiat');
    const asked = new Date(Date.now() - 90 * MINUTE);
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: base.id,
        price: '100',
        timestamp: new Date(asked.getTime() + 61 * MINUTE),
        source: 'coingecko',
      },
    ]);
    const { service, asked: providerAsked } = pricingService();

    expect(await service.getTokenPrice(token, base, asked)).toBe('200');
    expect(providerAsked).toEqual([token.id]);
    // The quote lands at the time asked, before the row that was not reused.
    const stored = await storedFor(token.id, base.id);
    expect(stored.map((r) => r.price)).toEqual(['200', '100']);
    expect(stored[0]?.timestamp.getTime()).toBe(asked.getTime());
  });
});
