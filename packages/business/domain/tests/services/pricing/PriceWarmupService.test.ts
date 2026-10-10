/**
 * The import warm-up (foundation A3, Tasks 5, 7 and 15): it fetches against
 * the fiat USD, as every provider quote is stored from PR-6 on (D-4), and
 * answers in the user's base through `PriceReader`.
 *
 * The warm-up resolves the user's base through the global connection, so
 * every row here is committed and removed after each test.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Token, User } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { CurrentPriceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { PriceHubResolver } from '../../../src/services/pricing/PriceHubResolver';
import { PriceWarmupService } from '../../../src/services/pricing/PriceWarmupService';
import { PricingProviderRouter } from '../../../src/services/pricing/PricingProviderRouter';
import { PricingService } from '../../../src/services/pricing/PricingService';
import { committedRows, dropPricesOf } from '../../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { makeUser } from '../../../test/helpers/factories';
import { makeToken } from '../../../test/helpers/factories-extra';

restoreContainerAfterAll();

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

async function commitUser(baseCurrencyId: string | null): Promise<User> {
  const user = await getDb().transaction((tx) => makeUser(tx, { baseCurrencyId }));
  rows.users.push(user.id);
  return user;
}

interface Ask {
  tokenId: string;
  baseId: string;
  baseSymbol: string;
}

/** A warm-up whose only provider is CoinGecko in the registry, answering 100 and recording each ask. */
function warmup(): { service: PriceWarmupService; asks: Ask[] } {
  const asks: Ask[] = [];
  const coingecko: CurrentPriceProvider = {
    providerKey: 'coingecko',
    capabilities: ['current-price'],
    canPrice: () => true,
    fetchCurrentPrice: async (token, ctx) => {
      asks.push({
        tokenId: token.id,
        baseId: ctx.baseCurrency.id,
        baseSymbol: ctx.baseCurrency.symbol,
      });
      return {
        tokenId: token.id,
        baseTokenId: ctx.baseCurrency.id,
        price: '100',
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
  Container.set(PricingService, new PricingService());
  return { service: new PriceWarmupService(), asks };
}

describe('PriceWarmupService.warm', () => {
  test('the warm-up asks in USD and answers in the user’s base', async () => {
    const usdId = await Container.get(PriceHubResolver).usdTokenId();
    const base = await commitToken('fiat');
    // One of the user's base buys 2 USD.
    await getDb()
      .insert(schema.tokenPrices)
      .values({
        tokenId: base.id,
        baseTokenId: usdId,
        price: '2',
        timestamp: new Date(Date.now() - 60_000),
        source: 'frankfurter',
      });
    const user = await commitUser(base.id);
    const token = await commitToken();
    const { service, asks } = warmup();

    const prices = await service.warm({ userId: user.id, tokenIds: [token.id] });

    expect(asks).toEqual([{ tokenId: token.id, baseId: usdId, baseSymbol: 'USD' }]);
    expect(prices.get(token.id)).toBe('50');
    const stored = await getDb()
      .select()
      .from(schema.tokenPrices)
      .where(eq(schema.tokenPrices.tokenId, token.id));
    expect(stored.map((r) => r.baseTokenId)).toEqual([usdId]);
  });

  test('a user with no base currency is asked in USD', async () => {
    const user = await commitUser(null);
    const token = await commitToken();
    const { service, asks } = warmup();

    await service.warm({ userId: user.id, tokenIds: [token.id] });

    expect(asks.map((a) => a.baseSymbol)).toEqual(['USD']);
  });
});
