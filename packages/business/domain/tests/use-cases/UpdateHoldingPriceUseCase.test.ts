/**
 * Characterization (foundation A3, Task 5): the refresh button, before
 * Tasks 6 and 7 move the write under it.
 *
 * `fetched` compares the pair's latest stored row before and after the
 * price call (SC-148). The holding is read and the price written through the
 * global connection, so every row here is committed and removed after each
 * test. The vault recalculation is best-effort and not the subject; it is
 * stubbed.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Holding, NewTokenPrice, Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { CurrentPriceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { PriceQuote } from '@scani/providers/core/types';
import { and, asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { CurrencyConverter } from '../../src/services/pricing/CurrencyConverter';
import { PricingProviderRouter } from '../../src/services/pricing/PricingProviderRouter';
import { PricingService } from '../../src/services/pricing/PricingService';
import { VaultService } from '../../src/services/users/VaultService';
import { UpdateHoldingPriceUseCase } from '../../src/use-cases/UpdateHoldingPriceUseCase';
import { committedRows, dropPricesOf } from '../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

restoreContainerAfterAll();

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

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

interface Scaffold {
  userId: string;
  token: Token;
  base: Token;
  holding: Holding;
}

/** A user's holding of a crypto token, and a fiat base, committed. */
function commitHolding(): Promise<Scaffold> {
  return getDb().transaction(async (tx) => {
    const user = await makeUser(tx);
    rows.users.push(user.id);
    // Upserted onto a seeded code, so no institution type outlives the test.
    const type = await makeInstitutionType(tx, { code: 'crypto_exchange' });
    const institution = await makeInstitution(tx, { typeId: type.id });
    rows.institutions.push(institution.id);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const token = await makeToken(tx);
    const base = await makeToken(tx, { typeId: fiatTypeId });
    rows.tokens.push(token.id, base.id);
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
    });
    return { userId: user.id, token, base, holding };
  });
}

async function commitPrice(price: NewTokenPrice): Promise<void> {
  await getDb().insert(schema.tokenPrices).values(price);
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

/** The use case over a `PricingService` whose only provider is CoinGecko, answering from `answer`. */
function refresh(answer: (token: Token) => PriceQuote | null): {
  useCase: UpdateHoldingPriceUseCase;
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
  Container.set(PricingProviderRouter, new PricingProviderRouter());
  Container.set(CurrencyConverter, new CurrencyConverter());
  Container.set(PricingService, new PricingService());
  Container.set(VaultService, {
    recalculateVaultsForHolding: async () => {},
  } as unknown as VaultService);
  return { useCase: new UpdateHoldingPriceUseCase(), asked };
}

describe('refresh reports fetched: true when a newer row landed, false when none did', () => {
  test('no row in the last hour: the quote lands and fetched is true', async () => {
    const { userId, token, base, holding } = await commitHolding();
    // A stored row, so `fetched` compares two stamps rather than reading true
    // off an empty pair.
    await commitPrice({
      tokenId: token.id,
      baseTokenId: base.id,
      price: '90',
      timestamp: new Date(Date.now() - 3 * HOUR),
      source: 'coingecko',
    });
    const stamp = new Date();
    const { useCase, asked } = refresh((t) => ({
      tokenId: t.id,
      baseTokenId: base.id,
      price: '100',
      timestamp: stamp,
      source: 'coingecko',
    }));

    const result = await useCase.execute(holding.id, userId, base);

    expect(asked).toEqual([token.id]);
    expect(result).toEqual({
      success: true,
      price: '100',
      source: 'coingecko',
      timestamp: stamp.toISOString(),
      fetched: true,
    });
    expect((await storedFor(token.id, base.id)).map((r) => r.price)).toEqual(['90', '100']);
  });

  test('a row ten minutes old is reused: no provider call, fetched is false', async () => {
    const { userId, token, base, holding } = await commitHolding();
    const storedAt = new Date(Date.now() - 10 * MINUTE);
    await commitPrice({
      tokenId: token.id,
      baseTokenId: base.id,
      price: '90',
      timestamp: storedAt,
      source: 'coingecko',
    });
    const { useCase, asked } = refresh((t) => ({
      tokenId: t.id,
      baseTokenId: base.id,
      price: '100',
      timestamp: new Date(),
      source: 'coingecko',
    }));

    const result = await useCase.execute(holding.id, userId, base);

    expect(asked).toEqual([]);
    expect(result).toEqual({
      success: true,
      price: '90',
      source: 'coingecko',
      timestamp: storedAt.toISOString(),
      fetched: false,
    });
  });

  test('the provider has nothing: the older row is returned and fetched is false', async () => {
    const { userId, token, base, holding } = await commitHolding();
    const storedAt = new Date(Date.now() - 3 * HOUR);
    await commitPrice({
      tokenId: token.id,
      baseTokenId: base.id,
      price: '90',
      timestamp: storedAt,
      source: 'coingecko',
    });
    const { useCase, asked } = refresh(() => null);

    const result = await useCase.execute(holding.id, userId, base);

    expect(asked).toEqual([token.id]);
    expect(result).toEqual({
      success: true,
      price: '90',
      source: 'coingecko',
      timestamp: storedAt.toISOString(),
      fetched: false,
    });
    expect(await storedFor(token.id, base.id)).toHaveLength(1);
  });
});

// The provider's stamp is what lands (see the router's write-back test), so a
// quote dated before the stored row is written and is not "newer". The price
// returned is the new quote's; the source and time are the row that was
// already there, which is still the pair's latest.
test('a quote stamped before the stored row lands, and fetched is still false', async () => {
  const { userId, token, base, holding } = await commitHolding();
  const storedAt = new Date(Date.now() - 2 * HOUR);
  const providerStamp = new Date(Date.now() - 5 * HOUR);
  await commitPrice({
    tokenId: token.id,
    baseTokenId: base.id,
    price: '90',
    timestamp: storedAt,
    source: 'stored-source',
  });
  const { useCase, asked } = refresh((t) => ({
    tokenId: t.id,
    baseTokenId: base.id,
    price: '100',
    timestamp: providerStamp,
    source: 'coingecko',
  }));

  const result = await useCase.execute(holding.id, userId, base);

  expect(asked).toEqual([token.id]);
  expect(result).toEqual({
    success: true,
    price: '100',
    source: 'stored-source',
    timestamp: storedAt.toISOString(),
    fetched: false,
  });
  expect((await storedFor(token.id, base.id)).map((r) => r.price)).toEqual(['100', '90']);
});
