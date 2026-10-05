/**
 * A base is a token, never a symbol (foundation A3, Task 7).
 *
 * `findBySymbol` breaks a tie toward the newest row, so a base named by its
 * symbol becomes whichever token was created last under it. A test here
 * holds the seeded fiat USD beside a crypto token named USD created after it,
 * and asserts the path prices against the fiat, unless it says what else it
 * holds.
 *
 * The paths read and write through the global connection, so every row here
 * is committed and removed after each test.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Holding, NewTokenPrice, Token, User } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { logger } from '@scani/logging';
import { and, eq, isNull } from 'drizzle-orm';
import { Container } from 'typedi';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { HoldingQueryService } from '../../../src/services/holdings/HoldingQueryService';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { PortfolioValueCache } from '../../../src/services/portfolio/PortfolioValueCache';
import { PriceWarmupService } from '../../../src/services/pricing/PriceWarmupService';
import { PricingService } from '../../../src/services/pricing/PricingService';
import { VaultService } from '../../../src/services/users/VaultService';
import { UpdateHoldingPriceUseCase } from '../../../src/use-cases/UpdateHoldingPriceUseCase';
import { UpdateTokenPricesUseCase } from '../../../src/use-cases/UpdateTokenPricesUseCase';
import { committedRows, dropPricesOf } from '../../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';
import { withoutFiatUsd } from '../../../test/helpers/price-hubs';
import { pricingStack } from '../../../test/helpers/pricing-stack';

restoreContainerAfterAll();

const MINUTE = 60 * 1000;

const rows = committedRows();

afterEach(async () => {
  await dropPricesOf(rows.tokens);
  await rows.drop();
});

/** The seeded fiat token of a symbol: the fiat type and no market segment. */
async function fiat(symbol: string): Promise<Token> {
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
  if (!row) throw new Error(`the fiat ${symbol} is seeded by migration`);
  return row.token;
}

const fiatUsd = () => fiat('USD');

/** A crypto token carrying a fiat's symbol, created now and so after the fiat. */
async function commitCryptoNamed(symbol: string): Promise<Token> {
  const token = await getDb().transaction((tx) =>
    makeToken(tx, { symbol, name: `A coin named ${symbol}` })
  );
  rows.tokens.push(token.id);
  return token;
}

const commitCryptoNamedUsd = () => commitCryptoNamed('USD');

async function commitToken(): Promise<Token> {
  const token = await getDb().transaction((tx) => makeToken(tx));
  rows.tokens.push(token.id);
  return token;
}

async function commitUser(baseCurrencyId: string | null): Promise<User> {
  const user = await getDb().transaction((tx) => makeUser(tx, { baseCurrencyId }));
  rows.users.push(user.id);
  return user;
}

/** The user's holding of `tokenId`, at a fresh institution. */
function commitHolding(userId: string, tokenId: string, balance: string): Promise<Holding> {
  return getDb().transaction(async (tx) => {
    // Upserted onto a seeded code, so no institution type outlives the test.
    const type = await makeInstitutionType(tx, { code: 'crypto_exchange' });
    const institution = await makeInstitution(tx, { typeId: type.id });
    rows.institutions.push(institution.id);
    const account = await makeAccount(tx, { userId, institutionId: institution.id });
    return makeHolding(tx, { userId, accountId: account.id, tokenId, balance });
  });
}

async function commitPrice(price: NewTokenPrice): Promise<void> {
  await getDb().insert(schema.tokenPrices).values(price);
}

/** Redis is not part of any assertion here: every valuation is computed. */
function computeEveryValuation(): void {
  Container.set(PortfolioValueCache, {
    getOrCompute: async (_key: string, factory: () => Promise<unknown>) => factory(),
    bust: async () => {},
  } as unknown as PortfolioValueCache);
}

function basesStoredFor(tokenId: string): Promise<string[]> {
  return getDb()
    .select({ baseTokenId: schema.tokenPrices.baseTokenId })
    .from(schema.tokenPrices)
    .where(eq(schema.tokenPrices.tokenId, tokenId))
    .then((stored) => stored.map((r) => r.baseTokenId));
}

describe('a base is a token, never a symbol', () => {
  test('the hourly run writes against the fiat USD', async () => {
    const usd = await fiatUsd();
    await commitCryptoNamedUsd();
    const token = await commitToken();
    const asks = pricingStack();
    // The run prices every held token in the database; here, this one.
    Container.set(HoldingQueryService, {
      getDistinctTokenIds: async () => [token.id],
    } as unknown as HoldingQueryService);
    Container.set(VaultService, {
      recalculateVaultsForToken: async () => {},
    } as unknown as VaultService);

    const result = await new UpdateTokenPricesUseCase().execute();

    expect(result).toMatchObject({ tokensFound: 1, tokensUpdated: 1, tokensFailed: 0 });
    expect(asks).toEqual([{ tokenId: token.id, baseId: usd.id }]);
    expect(await basesStoredFor(token.id)).toEqual([usd.id]);
  });

  // A catalogue with no fiat USD is a broken install. The run counted every
  // token failed and finished green, which hid it.
  test('with no fiat USD in the catalogue the hourly run throws, naming the token', async () => {
    const token = await commitToken();
    const restore = withoutFiatUsd();
    try {
      const asks = pricingStack();
      Container.set(HoldingQueryService, {
        getDistinctTokenIds: async () => [token.id],
      } as unknown as HoldingQueryService);

      await expect(new UpdateTokenPricesUseCase().execute()).rejects.toThrow('no fiat USD token');
      expect(asks).toEqual([]);
    } finally {
      restore();
    }
  });

  test('the import warm-up asks in the user’s base token', async () => {
    const usd = await fiatUsd();
    await commitCryptoNamedUsd();
    const user = await commitUser(usd.id);
    const token = await commitToken();
    const asks = pricingStack();

    const prices = await new PriceWarmupService().warm({ userId: user.id, tokenIds: [token.id] });

    expect(prices.get(token.id)).toBe('100');
    expect(asks).toEqual([{ tokenId: token.id, baseId: usd.id }]);
    expect(await basesStoredFor(token.id)).toEqual([usd.id]);
  });

  test('the import warm-up of a user with no base currency asks in the fiat USD', async () => {
    const usd = await fiatUsd();
    await commitCryptoNamedUsd();
    const user = await commitUser(null);
    const token = await commitToken();
    const asks = pricingStack();

    await new PriceWarmupService().warm({ userId: user.id, tokenIds: [token.id] });

    expect(asks).toEqual([{ tokenId: token.id, baseId: usd.id }]);
    expect(await basesStoredFor(token.id)).toEqual([usd.id]);
  });

  test('the refresh button fetches against the user’s base token', async () => {
    const usd = await fiatUsd();
    await commitCryptoNamedUsd();
    const user = await commitUser(usd.id);
    const token = await commitToken();
    const holding = await commitHolding(user.id, token.id, '2');
    const asks = pricingStack();
    Container.set(VaultService, {
      recalculateVaultsForHolding: async () => {},
    } as unknown as VaultService);

    const result = await new UpdateHoldingPriceUseCase().execute(holding.id, user.id, usd);

    expect(result).toMatchObject({ success: true, price: '100', fetched: true });
    expect(asks).toEqual([{ tokenId: token.id, baseId: usd.id }]);
    expect(await basesStoredFor(token.id)).toEqual([usd.id]);
  });

  test('the live valuation reads the user’s base token', async () => {
    const usd = await fiatUsd();
    const coin = await commitCryptoNamedUsd();
    const user = await commitUser(usd.id);
    const token = await commitToken();
    await commitHolding(user.id, token.id, '2');
    const now = Date.now();
    await commitPrice({
      tokenId: token.id,
      baseTokenId: usd.id,
      price: '100',
      timestamp: new Date(now - 5 * MINUTE),
      source: 'coingecko',
    });
    // Newer, and against the coin: the price a symbol lookup of 'USD' serves.
    await commitPrice({
      tokenId: token.id,
      baseTokenId: coin.id,
      price: '7',
      timestamp: new Date(now - MINUTE),
      source: 'coingecko',
    });
    pricingStack();
    computeEveryValuation();

    const portfolio = await new PortfolioValuationService().getUserPortfolioValue(user.id);

    expect(portfolio.baseCurrency).toBe('USD');
    expect(
      portfolio.holdings.map((h) => [h.tokenId, h.currentPrice, h.value, h.priceSource])
    ).toEqual([[token.id, '100', '200', 'coingecko']]);
    expect(portfolio.totalValue).toBe('200');
  });

  // The user's base is not USD here, so a path that ignored it and fell to
  // USD fails as surely as one that looked the symbol up.
  test('the live valuation of a user banking in the fiat EUR reads against it, not a later crypto token named EUR', async () => {
    const eur = await fiat('EUR');
    const coin = await commitCryptoNamed('EUR');
    const user = await commitUser(eur.id);
    const token = await commitToken();
    await commitHolding(user.id, token.id, '2');
    const now = Date.now();
    await commitPrice({
      tokenId: token.id,
      baseTokenId: eur.id,
      price: '100',
      timestamp: new Date(now - 5 * MINUTE),
      source: 'coingecko',
    });
    // Newer, and against the coin: the price a symbol lookup of 'EUR' serves.
    await commitPrice({
      tokenId: token.id,
      baseTokenId: coin.id,
      price: '7',
      timestamp: new Date(now - MINUTE),
      source: 'coingecko',
    });
    pricingStack();
    computeEveryValuation();
    const read = spyOn(Container.get(PricingService), 'getCachedTokenPrices');

    const portfolio = await new PortfolioValuationService().getUserPortfolioValue(user.id);

    expect(read.mock.calls.map(([, base]) => base.id)).toEqual([eur.id]);
    expect(portfolio.baseCurrency).toBe('EUR');
    expect(
      portfolio.holdings.map((h) => [h.tokenId, h.currentPrice, h.value, h.priceSource])
    ).toEqual([[token.id, '100', '200', 'coingecko']]);
  });

  test('the live valuation of a portfolio with nothing to price does not read the base token', async () => {
    const usd = await fiatUsd();
    const user = await commitUser(usd.id);
    pricingStack();
    computeEveryValuation();
    const read = spyOn(Container.get(TokenRepository), 'findById');
    try {
      const portfolio = await new PortfolioValuationService().getUserPortfolioValue(user.id);

      expect(portfolio.holdings).toEqual([]);
      expect(read.mock.calls.filter(([id]) => id === usd.id)).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });

  test('a base id that names no token is warned about by id, and answered with the fiat USD', async () => {
    const usd = await fiatUsd();
    await commitCryptoNamedUsd();
    const gone = crypto.randomUUID();
    const service = new PricingService();
    const warned = spyOn(logger, 'warn').mockImplementation(() => {});
    const warnings = () =>
      warned.mock.calls.filter(([, message]) => String(message).startsWith('Base currency id'));
    try {
      expect((await service.baseToken(gone)).id).toBe(usd.id);
      expect(warnings()).toEqual([
        [{ baseCurrencyId: gone }, 'Base currency id names no token, pricing in the fiat USD'],
      ]);

      // CONTROL: no id given, or one a token carries, is no warning.
      warned.mockClear();
      expect((await service.baseToken()).id).toBe(usd.id);
      expect((await service.baseToken(null)).id).toBe(usd.id);
      expect((await service.baseToken(usd.id)).id).toBe(usd.id);
      expect(warnings()).toEqual([]);
    } finally {
      warned.mockRestore();
    }
  });

  test('a vault in the fiat USD prices its holdings against it', async () => {
    const usd = await fiatUsd();
    await commitCryptoNamedUsd();
    const user = await commitUser(usd.id);
    const token = await commitToken();
    const holding = await commitHolding(user.id, token.id, '2');
    const [vault] = await getDb()
      .insert(schema.vaults)
      .values({
        userId: user.id,
        name: 'A vault',
        targetAmount: '1000',
        currencyId: usd.id,
        color: '#3b82f6',
      })
      .returning();
    if (!vault) throw new Error('vault insert failed');
    await getDb()
      .insert(schema.vaultHoldings)
      .values({ vaultId: vault.id, holdingId: holding.id, percentage: 50 });
    // The holding has no stored price, so the vault asks the pricing stack.
    const asks = pricingStack();
    const vaults = new VaultService();

    const detail = await vaults.getVaultWithProgress(vault.id);
    await vaults.recalculateVaultAmount(vault.id);

    expect(asks).toEqual([{ tokenId: token.id, baseId: usd.id }]);
    expect(await basesStoredFor(token.id)).toEqual([usd.id]);
    expect(detail?.holdings.map((h) => [h.holdingValue, h.attributedValue])).toEqual([
      ['200', '100'],
    ]);
    const [recalculated] = await getDb()
      .select({ currentAmount: schema.vaults.currentAmount })
      .from(schema.vaults)
      .where(eq(schema.vaults.id, vault.id));
    expect(recalculated?.currentAmount).toBe('100');
  });
});
