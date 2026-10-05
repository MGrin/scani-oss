/**
 * Characterization (foundation A3, Task 5): which base the import warm-up
 * asks in today, before Task 7 hands it the base as a token.
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
import { CurrencyConverter } from '../../../src/services/pricing/CurrencyConverter';
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
      };
    },
  };
  const registry = new ProviderRegistry();
  registry.register(coingecko);
  Container.set(ProviderRegistry, registry);
  Container.set(PricingProviderRouter, new PricingProviderRouter());
  Container.set(CurrencyConverter, new CurrencyConverter());
  Container.set(PricingService, new PricingService());
  return { service: new PriceWarmupService(), asks };
}

describe('PriceWarmupService.warm', () => {
  test('the warm-up asks in the user’s base', async () => {
    const base = await commitToken('fiat');
    const user = await commitUser(base.id);
    const token = await commitToken();
    const { service, asks } = warmup();

    const prices = await service.warm({ userId: user.id, tokenIds: [token.id] });

    expect(asks).toEqual([{ tokenId: token.id, baseId: base.id, baseSymbol: base.symbol }]);
    expect(prices.get(token.id)).toBe('100');
    const stored = await getDb()
      .select()
      .from(schema.tokenPrices)
      .where(eq(schema.tokenPrices.tokenId, token.id));
    expect(stored.map((r) => r.baseTokenId)).toEqual([base.id]);
  });

  test('a user with no base currency is asked in USD', async () => {
    const user = await commitUser(null);
    const token = await commitToken();
    const { service, asks } = warmup();

    await service.warm({ userId: user.id, tokenIds: [token.id] });

    expect(asks.map((a) => a.baseSymbol)).toEqual(['USD']);
  });
});
