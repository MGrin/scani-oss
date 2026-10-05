/**
 * Foundation A3, Task 10. A pair the read path could not answer is refreshed
 * by pricing its two currencies against USD through the provider registry.
 * The read then crosses USD, so nothing has to store the pair itself.
 *
 * The pricing stack and the stored-rate reader are real, over one provider
 * that answers from a table and records each ask. Every row is committed and
 * removed after each test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { CurrencyConverter, PricingService } from '@scani/domain/services';
import {
  dropPricesOf,
  makeToken,
  pricingStack,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import type { CurrencyRateRefreshJob } from '@scani/jobs';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ExchangeRateApiClient } from '@scani/providers/providers/exchangerate-api';
import { FrankfurterProvider } from '@scani/providers/providers/frankfurter';
import type { ProcessorContext } from '@scani/queue';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Container } from 'typedi';
import { PricingProviderRouter } from '../../../../../packages/business/domain/src/services/pricing/PricingProviderRouter';
import { CurrencyRateRefreshProcessor } from '../../src/processors/currency-rate-refresh';

restoreContainerAfterAll();

const CTX = { job: { id: 'job-1' } } as unknown as ProcessorContext;

const made: string[] = [];
const pricedSeedTokens: string[] = [];
const realFetch = globalThis.fetch;
let fetched: string[] = [];

// The refresh reaches a vendor through the registry or not at all.
beforeEach(() => {
  fetched = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    throw new Error('the rate refresh reached the network');
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const tokens = made.splice(0);
  await dropPricesOf([...tokens, ...pricedSeedTokens.splice(0)]);
  if (tokens.length > 0) {
    await getDb().delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
  }
});

async function commitToken(): Promise<Token> {
  const token = await getDb().transaction((tx) => makeToken(tx));
  made.push(token.id);
  return token;
}

/** The seeded fiat: the fiat type and no market segment. */
async function seededFiat(symbol = 'USD'): Promise<Token> {
  const [row] = await getDb()
    .select({ token: schema.tokens })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
    .where(
      and(
        eq(schema.tokens.symbol, symbol),
        eq(schema.tokenTypes.code, 'fiat'),
        isNull(schema.tokens.marketSegment)
      )
    );
  if (!row) throw new Error(`fiat ${symbol} must be seeded by migration`);
  return row.token;
}

function refresh(from: Token, to: Token): Promise<unknown> {
  const job: CurrencyRateRefreshJob = {
    userId: 'user-1',
    requestId: 'read-miss-1',
    fromTokenId: from.id,
    fromSymbol: from.symbol,
    toTokenId: to.id,
    toSymbol: to.symbol,
  };
  const processor = new CurrencyRateRefreshProcessor();
  return (
    processor as unknown as {
      handle: (data: CurrencyRateRefreshJob, ctx: ProcessorContext) => Promise<unknown>;
    }
  ).handle(job, CTX);
}

/** Every stored row of these tokens, as token, base and price. */
async function storedFor(tokens: Token[]): Promise<string[][]> {
  const rows = await getDb()
    .select()
    .from(schema.tokenPrices)
    .where(
      inArray(
        schema.tokenPrices.tokenId,
        tokens.map((token) => token.id)
      )
    )
    .orderBy(asc(schema.tokenPrices.price));
  return rows.map((row) => [row.tokenId, row.baseTokenId, row.price]);
}

describe('CurrencyRateRefreshProcessor', () => {
  test('a fiat outside the ECB and old fallback lists is refreshed through the real registry route', async () => {
    const usd = await seededFiat();
    const from = await seededFiat('ETB');
    const to = await seededFiat('SOS');
    pricedSeedTokens.push(from.id, to.id);
    let asks = 0;
    const provider = new FrankfurterProvider(
      { execute: async <T>(fn: () => Promise<T>) => fn() } as OutflowRateLimiter,
      {
        fetchUsdRates: async () => {
          asks++;
          return { rates: { USD: '1', ETB: '100', SOS: '5' }, fetchedAt: new Date() };
        },
      } as unknown as ExchangeRateApiClient
    );
    const registry = new ProviderRegistry();
    registry.register(provider);
    Container.set(ProviderRegistry, registry);
    Container.set(PricingProviderRouter, new PricingProviderRouter());
    Container.set(CurrencyConverter, new CurrencyConverter());
    Container.set(PricingService, new PricingService());
    const reader = Container.get(CurrencyConverter);
    expect(await reader.getStoredRateDetail(from, to, new Date())).toBeNull();

    expect(await refresh(from, to)).toMatchObject({ refreshed: true });

    expect(await storedFor([from, to])).toEqual([
      [from.id, usd.id, '0.01'],
      [to.id, usd.id, '0.2'],
    ]);
    expect(asks).toBe(2);
    expect(await reader.getStoredRateDetail(from, to, new Date())).toMatchObject({ rate: '0.05' });
    expect(fetched).toEqual([]);
  });

  test('the rate refresh writes the pair’s two currencies against USD', async () => {
    const usd = await seededFiat();
    const from = await commitToken();
    const to = await commitToken();
    const asks = pricingStack((tokenId) => (tokenId === from.id ? '4' : '2'));

    const result = await refresh(from, to);

    expect(result).toMatchObject({ refreshed: true });
    expect(await storedFor([from, to])).toEqual([
      [to.id, usd.id, '2'],
      [from.id, usd.id, '4'],
    ]);
    expect(asks).toHaveLength(2);
    expect(asks).toContainEqual({ tokenId: from.id, baseId: usd.id });
    expect(asks).toContainEqual({ tokenId: to.id, baseId: usd.id });
    expect(fetched).toEqual([]);
  });

  test('a pair against USD asks for the one currency', async () => {
    const usd = await seededFiat();
    const from = await commitToken();
    const asks = pricingStack(() => '4');

    const result = await refresh(from, usd);

    expect(result).toMatchObject({ refreshed: true });
    expect(await storedFor([from])).toEqual([[from.id, usd.id, '4']]);
    expect(asks).toEqual([{ tokenId: from.id, baseId: usd.id }]);
    expect(fetched).toEqual([]);
  });

  // The read is `tokens.getBaseCurrencyRates`'s: it never fetches, and a miss
  // queues this job again. So the refresh has to leave the pair answerable.
  test('after the refresh, the pair that missed is answered', async () => {
    const from = await commitToken();
    const to = await commitToken();
    pricingStack((tokenId) => (tokenId === from.id ? '4' : '2'));
    const reader = Container.get(CurrencyConverter);
    expect(await reader.getStoredRateDetail(from, to, new Date())).toBeNull();

    await refresh(from, to);

    expect(await reader.getStoredRateDetail(from, to, new Date())).toMatchObject({ rate: '2' });
  });
});
