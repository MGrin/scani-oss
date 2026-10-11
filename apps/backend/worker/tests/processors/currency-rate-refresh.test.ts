/**
 * Foundation A3, Task 10. A pair the read path could not answer is refreshed
 * by pricing its two currencies against USD through the provider registry.
 * The read then crosses USD, so nothing has to store the pair itself.
 *
 * The pricing stack and `PriceReader` are real, over one provider
 * that answers from a table and records each ask. Every row is committed and
 * removed after each test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { PriceReader, PricingService } from '@scani/domain/services';
import { CacheWriteCounter } from '@scani/domain/services/feeds/CacheWriteCounter';
import {
  CBR_TABLE_URL,
  dropPricesOf,
  fixing,
  freshFrankfurterClient,
  makeToken,
  pricingStack,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import type { CurrencyRateRefreshJob } from '@scani/jobs';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { FrankfurterProvider } from '@scani/providers/providers/frankfurter';
import type { ProcessorContext } from '@scani/queue';
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

/** What `tokens.getBaseCurrencyRates` answers for the pair: one `from` in `to`, from stored rows. */
async function rateOf(from: Token, to: Token): Promise<string | null> {
  const answer = (await new PriceReader().at([from.id], to.id, new Date())).get(from.id);
  return answer?.price.toString() ?? null;
}

describe('CurrencyRateRefreshProcessor', () => {
  test('a fiat only the Bank of Russia publishes is refreshed through the real registry route', async () => {
    const usd = await seededFiat();
    const from = await seededFiat('KGS');
    const to = await seededFiat('MNT');
    pricedSeedTokens.push(from.id, to.id);
    // The one client's routing decides which table is asked; only the Bank of
    // Russia's answers. Invented: units of each per one USD.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      fetched.push(url);
      if (url === CBR_TABLE_URL)
        return Response.json(fixing('USD', '2026-01-09', { KGS: 100, MNT: 5 }));
      throw new Error(`the rate refresh asked ${url}`);
    }) as unknown as typeof fetch;
    const provider = new FrankfurterProvider(freshFrankfurterClient());
    const registry = new ProviderRegistry();
    registry.register(provider);
    Container.set(ProviderRegistry, registry);
    Container.set(PricingProviderRouter, new PricingProviderRouter());
    Container.set(PricingService, new PricingService());
    expect(await rateOf(from, to)).toBeNull();

    expect(await refresh(from, to)).toMatchObject({ refreshed: true });

    expect(await storedFor([from, to])).toEqual([
      [from.id, usd.id, '0.01'],
      [to.id, usd.id, '0.2'],
    ]);
    expect(await rateOf(from, to)).toBe('0.05');
    // One Bank of Russia table answered both, and nothing else was asked.
    expect(fetched).toEqual([CBR_TABLE_URL]);
  });

  test('the rate refresh writes the pair’s two currencies against USD', async () => {
    const usd = await seededFiat();
    const from = await commitToken();
    const to = await commitToken();
    const asks = pricingStack((tokenId) => (tokenId === from.id ? '4' : '2'));
    const counted: Array<[string, number]> = [];
    Container.set(CacheWriteCounter, {
      add: async (trigger: string, writes: number) => {
        counted.push([trigger, writes]);
      },
    } as unknown as CacheWriteCounter);

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
    // Counted as the FX refresh's, apart from the price runs' (SC-1610).
    expect(counted).toEqual([['fx', 0]]);
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
    expect(await rateOf(from, to)).toBeNull();

    await refresh(from, to);

    expect(await rateOf(from, to)).toBe('2');
  });
});
