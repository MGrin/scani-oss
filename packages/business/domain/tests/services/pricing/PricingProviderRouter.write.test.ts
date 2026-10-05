/**
 * Characterization (foundation A3, Task 5): what the router's write-back
 * stores today, before Task 6 moves it onto `PriceWriter`.
 *
 * The router writes through the global connection, so every row here is
 * committed and removed after each test.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { logger } from '@scani/logging';
import type { CurrentPriceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { PriceQuote } from '@scani/providers/core/types';
import { asc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { PricingProviderRouter } from '../../../src/services/pricing/PricingProviderRouter';
import { committedRows, dropPricesOf } from '../../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { makeToken } from '../../../test/helpers/factories-extra';

restoreContainerAfterAll();

const rows = committedRows();

afterEach(async () => {
  await dropPricesOf(rows.tokens);
  await rows.drop();
});

async function commitToken(): Promise<Token> {
  const token = await getDb().transaction((tx) => makeToken(tx));
  rows.tokens.push(token.id);
  return token;
}

function storedFor(tokenIds: string[]) {
  return getDb()
    .select()
    .from(schema.tokenPrices)
    .where(inArray(schema.tokenPrices.tokenId, tokenIds))
    .orderBy(asc(schema.tokenPrices.timestamp));
}

/** CoinGecko in the registry, answering from `answer`; every token asked is recorded. */
function routerAnswering(answer: (token: Token) => PriceQuote | null): {
  router: PricingProviderRouter;
  asked: string[];
} {
  const asked: string[] = [];
  const coingecko: CurrentPriceProvider = {
    providerKey: 'coingecko',
    capabilities: ['current-price'],
    canPrice: () => true,
    fetchCurrentPrice: async (token) => {
      asked.push(token.id);
      return answer(token);
    },
  };
  const registry = new ProviderRegistry();
  registry.register(coingecko);
  Container.set(ProviderRegistry, registry);
  return { router: new PricingProviderRouter(), asked };
}

describe('PricingProviderRouter write-back', () => {
  test('a quote lands with its provider’s stamp, the call’s base and no granularity given', async () => {
    const token = await commitToken();
    const base = await commitToken();
    const otherBase = await commitToken();
    const callAt = new Date();
    const providerStamp = new Date(callAt.getTime() - 3 * 60 * 60 * 1000);
    const { router, asked } = routerAnswering((t) => ({
      tokenId: t.id,
      // The quote names a different base; the router writes the one it was called with.
      baseTokenId: otherBase.id,
      price: '100',
      timestamp: providerStamp,
      source: 'coingecko',
    }));

    await router.routeAndFetch([token], base, callAt);

    expect(asked).toEqual([token.id]);
    const stored = await storedFor([token.id]);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.baseTokenId).toBe(base.id);
    expect(stored[0]?.timestamp.getTime()).toBe(providerStamp.getTime());
    expect(stored[0]?.timestamp.getTime()).not.toBe(callAt.getTime());
    expect(stored[0]?.price).toBe('100');
    expect(stored[0]?.source).toBe('coingecko');
    expect(stored[0]?.granularity).toBe('intraday');
  });

  // Changed by Task 6, the one change in behaviour this move makes. The router
  // dropped by `parseFloat`, so a text was dropped only when it read 0 or NaN,
  // and '-5', '12abc', ' 1.5', '+1' and 'Infinity' were written verbatim. The
  // writer sends only a positive decimal the column will take.
  test('only a positive decimal is written: zero, negative and non-canonical texts are not', async () => {
    const base = await commitToken();
    const texts = {
      zero: '0',
      zeroWithDecimals: '0.00',
      unparsable: 'abc',
      negative: '-5',
      trailingLetters: '12abc',
      padded: ' 1.5',
      signed: '+1',
      infinite: 'Infinity',
      positive: '100',
    } as const;
    const tokenOf = new Map<string, Token>();
    for (const name of Object.keys(texts)) tokenOf.set(name, await commitToken());
    const priceOf = new Map<string, string>(
      Object.entries(texts).map(([name, text]) => [tokenOf.get(name)?.id ?? '', text])
    );
    const callAt = new Date();
    const { router } = routerAnswering((t) => ({
      tokenId: t.id,
      baseTokenId: base.id,
      price: priceOf.get(t.id) ?? '',
      timestamp: callAt,
      source: 'coingecko',
    }));

    const returned = await router.routeAndFetch([...tokenOf.values()], base, callAt);

    // Every quote comes back to the caller, written or not.
    expect(returned.map((r) => r.price).sort()).toEqual(Object.values<string>(texts).sort());
    const stored = await storedFor([...priceOf.keys()]);
    expect(stored.map((r) => [r.tokenId, r.price])).toEqual([
      [tokenOf.get('positive')?.id ?? '', '100'],
    ]);
  });

  test('a re-quote at the same provider stamp overwrites the price and the source', async () => {
    const token = await commitToken();
    const base = await commitToken();
    const stamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const first = routerAnswering((t) => ({
      tokenId: t.id,
      baseTokenId: base.id,
      price: '100',
      timestamp: stamp,
      source: 'coingecko',
    }));
    await first.router.routeAndFetch([token], base, new Date());
    const second = routerAnswering((t) => ({
      tokenId: t.id,
      baseTokenId: base.id,
      price: '101',
      timestamp: stamp,
      source: 'coingecko-requote',
    }));

    await second.router.routeAndFetch([token], base, new Date());

    const stored = await storedFor([token.id]);
    expect(stored.map((r) => [r.price, r.source, r.timestamp.getTime()])).toEqual([
      ['101', 'coingecko-requote', stamp.getTime()],
    ]);
  });

  test('a write error is logged and the quotes are still returned', async () => {
    const token = await commitToken();
    const base = await commitToken();
    // A base with no `tokens` row: the insert fails on its foreign key.
    const missingBase: Token = { ...base, id: randomUUID() };
    const callAt = new Date();
    const { router } = routerAnswering((t) => ({
      tokenId: t.id,
      baseTokenId: missingBase.id,
      price: '100',
      timestamp: callAt,
      source: 'coingecko',
    }));
    const logged = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const returned = await router.routeAndFetch([token], missingBase, callAt);

      expect(returned).toEqual([
        { tokenId: token.id, price: '100', timestamp: callAt, source: 'coingecko' },
      ]);
      expect(logged.mock.calls.map(([, message]) => message)).toContain(
        'Failed to cache price results'
      );
    } finally {
      logged.mockRestore();
    }
    const stored = await getDb()
      .select()
      .from(schema.tokenPrices)
      .where(eq(schema.tokenPrices.tokenId, token.id));
    expect(stored).toHaveLength(0);
  });
});
