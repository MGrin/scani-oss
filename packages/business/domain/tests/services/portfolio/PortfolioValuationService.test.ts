process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  PortfolioValuationService,
  type PortfolioValueResult,
  sumPortfolioDebtByAccount,
} from '../../../src/services/portfolio/PortfolioValuationService';
import { PortfolioValueCache } from '../../../src/services/portfolio/PortfolioValueCache';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * PortfolioValuationService — pure math unit tests.
 *
 * The actual service fetches holdings from the DB and prices from PriceReader.
 * Here we test the calculation logic in isolation by reproducing the exact
 * formulas the service uses (balance * price, summing totals, etc.).
 */

// ---------------------------------------------------------------------------
// Helpers that mirror the service's internal calculation logic
// ---------------------------------------------------------------------------

interface MockHolding {
  tokenSymbol: string;
  balance: string;
  tokenId: string;
}

interface PriceMap {
  [tokenId: string]: string; // tokenId -> price string
}

function calculateHoldingValue(balance: string, price: string): string {
  return new Decimal(balance).mul(new Decimal(price)).toString();
}

function calculateTotalValue(
  holdings: MockHolding[],
  prices: PriceMap,
  baseCurrencyId: string
): {
  totalValue: string;
  holdingValues: Array<{ tokenSymbol: string; value: string | null }>;
} {
  // Mirror the service: missing prices produce `null`, never '0'. Null
  // values are listed in the output (so the UI can show "—") but
  // EXCLUDED from the summed total. See PortfolioValuationService.
  const holdingValues = holdings.map((h) => {
    const currentPrice = h.tokenId === baseCurrencyId ? '1' : (prices[h.tokenId] ?? null);
    const value = currentPrice === null ? null : calculateHoldingValue(h.balance, currentPrice);
    return { tokenSymbol: h.tokenSymbol, value };
  });

  const totalValue = holdingValues.reduce(
    (sum, h) => (h.value !== null ? sum.add(new Decimal(h.value)) : sum),
    new Decimal(0)
  );

  return { totalValue: totalValue.toString(), holdingValues };
}

function calculateAssetAllocation(
  holdingValues: Array<{ tokenSymbol: string; value: string; typeCode: string }>
): Array<{ typeCode: string; value: string; percentage: string }> {
  // Group by typeCode
  const grouped = new Map<string, Decimal>();
  for (const h of holdingValues) {
    const current = grouped.get(h.typeCode) || new Decimal(0);
    grouped.set(h.typeCode, current.add(new Decimal(h.value)));
  }

  const total = Array.from(grouped.values()).reduce((sum, v) => sum.add(v), new Decimal(0));

  const result: Array<{ typeCode: string; value: string; percentage: string }> = [];
  for (const [typeCode, value] of grouped.entries()) {
    const percentage = total.isZero() ? '0' : value.div(total).mul(100).toFixed(2);
    result.push({ typeCode, value: value.toString(), percentage });
  }

  return result.sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PortfolioValuationService (unit — math)', () => {
  const baseCurrencyId = 'usd-token-id';

  describe('calculateTotalValue', () => {
    it('should sum values of multiple holdings correctly', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'BTC', balance: '1.5', tokenId: 'btc-id' },
        { tokenSymbol: 'ETH', balance: '10', tokenId: 'eth-id' },
        { tokenSymbol: 'USD', balance: '5000', tokenId: baseCurrencyId },
      ];
      const prices: PriceMap = {
        'btc-id': '60000',
        'eth-id': '3000',
      };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);

      // BTC: 1.5 * 60000 = 90000
      // ETH: 10 * 3000 = 30000
      // USD: 5000 * 1 = 5000
      expect(result.totalValue).toBe('125000');
      expect(result.holdingValues).toHaveLength(3);
    });

    it('should treat base currency price as 1', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'USD', balance: '1234.56', tokenId: baseCurrencyId },
      ];

      const result = calculateTotalValue(holdings, {}, baseCurrencyId);
      expect(result.totalValue).toBe('1234.56');
    });

    it('should surface null (not 0) for tokens without a price and exclude them from the total', () => {
      // Replaces the prior "use 0 for tokens without a price" assertion.
      // The silent-zero behaviour was the bug that zeroed every
      // dashboard after a base-currency switch — unpriceable holdings
      // now produce a null value and contribute nothing to the sum.
      const holdings: MockHolding[] = [
        { tokenSymbol: 'UNKNOWN', balance: '100', tokenId: 'unknown-id' },
      ];

      const result = calculateTotalValue(holdings, {}, baseCurrencyId);
      expect(result.totalValue).toBe('0');
      expect(result.holdingValues[0]?.value).toBeNull();
    });

    it('should exclude unpriceable holdings from total while including priced ones', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'BTC', balance: '1', tokenId: 'btc-id' },
        { tokenSymbol: 'UNKNOWN', balance: '100', tokenId: 'unknown-id' },
      ];
      const prices: PriceMap = { 'btc-id': '60000' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      expect(result.totalValue).toBe('60000');
      expect(result.holdingValues).toHaveLength(2);
      expect(result.holdingValues[1]?.value).toBeNull();
    });

    it('should handle empty holdings', () => {
      const result = calculateTotalValue([], {}, baseCurrencyId);
      expect(result.totalValue).toBe('0');
      expect(result.holdingValues).toHaveLength(0);
    });

    it('should preserve decimal precision', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'ETH', balance: '0.123456789', tokenId: 'eth-id' },
      ];
      const prices: PriceMap = { 'eth-id': '3000.50' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      // 0.123456789 * 3000.50 = 370.438204894500 (exact with Decimal.js)
      const expected = new Decimal('0.123456789').mul('3000.50').toString();
      expect(result.totalValue).toBe(expected);
    });
  });

  describe('calculateAssetAllocation', () => {
    it('should calculate correct percentages for multiple types', () => {
      const holdingValues = [
        { tokenSymbol: 'BTC', value: '60000', typeCode: 'crypto' },
        { tokenSymbol: 'ETH', value: '30000', typeCode: 'crypto' },
        { tokenSymbol: 'AAPL', value: '10000', typeCode: 'stock' },
      ];

      const result = calculateAssetAllocation(holdingValues);

      // crypto total = 90000 -> 90%
      // stock total = 10000 -> 10%
      expect(result).toHaveLength(2);

      const crypto = result.find((r) => r.typeCode === 'crypto');
      expect(crypto).toBeDefined();
      expect(crypto!.value).toBe('90000');
      expect(crypto!.percentage).toBe('90.00');

      const stock = result.find((r) => r.typeCode === 'stock');
      expect(stock).toBeDefined();
      expect(stock!.value).toBe('10000');
      expect(stock!.percentage).toBe('10.00');
    });

    it('should handle single asset type (100%)', () => {
      const holdingValues = [
        { tokenSymbol: 'BTC', value: '50000', typeCode: 'crypto' },
        { tokenSymbol: 'ETH', value: '25000', typeCode: 'crypto' },
      ];

      const result = calculateAssetAllocation(holdingValues);
      expect(result).toHaveLength(1);
      expect(result[0]?.typeCode).toBe('crypto');
      expect(result[0]?.percentage).toBe('100.00');
    });

    it('should return 0% when all values are zero', () => {
      const holdingValues = [
        { tokenSymbol: 'BTC', value: '0', typeCode: 'crypto' },
        { tokenSymbol: 'AAPL', value: '0', typeCode: 'stock' },
      ];

      const result = calculateAssetAllocation(holdingValues);
      for (const item of result) {
        expect(item.percentage).toBe('0');
      }
    });

    it('should handle empty input', () => {
      const result = calculateAssetAllocation([]);
      expect(result).toHaveLength(0);
    });

    it('should sort by value descending', () => {
      const holdingValues = [
        { tokenSymbol: 'AAPL', value: '5000', typeCode: 'stock' },
        { tokenSymbol: 'BTC', value: '100000', typeCode: 'crypto' },
        { tokenSymbol: 'USD', value: '500', typeCode: 'fiat' },
      ];

      const result = calculateAssetAllocation(holdingValues);
      expect(result[0]?.typeCode).toBe('crypto');
      expect(result[1]?.typeCode).toBe('stock');
      expect(result[2]?.typeCode).toBe('fiat');
    });
  });

  describe('handling of zero balances', () => {
    it('should return 0 value for a holding with zero balance', () => {
      const holdings: MockHolding[] = [{ tokenSymbol: 'BTC', balance: '0', tokenId: 'btc-id' }];
      const prices: PriceMap = { 'btc-id': '60000' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      expect(result.totalValue).toBe('0');
      expect(result.holdingValues[0]?.value).toBe('0');
    });

    it('should not affect total when mixed with non-zero balances', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'BTC', balance: '0', tokenId: 'btc-id' },
        { tokenSymbol: 'ETH', balance: '2', tokenId: 'eth-id' },
      ];
      const prices: PriceMap = { 'btc-id': '60000', 'eth-id': '3000' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      expect(result.totalValue).toBe('6000');
    });
  });

  describe('currency conversion logic', () => {
    it('should apply base currency price of 1 regardless of balance', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'USD', balance: '999999.99', tokenId: baseCurrencyId },
      ];

      const result = calculateTotalValue(holdings, {}, baseCurrencyId);
      expect(result.totalValue).toBe('999999.99');
    });

    it('should use the price map for non-base currencies', () => {
      const holdings: MockHolding[] = [{ tokenSymbol: 'EUR', balance: '100', tokenId: 'eur-id' }];
      // If the user's base is USD and EUR/USD rate is 1.08
      const prices: PriceMap = { 'eur-id': '1.08' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      expect(result.totalValue).toBe('108');
    });

    it('should handle very small fractional prices (DeFi tokens)', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'SHIB', balance: '1000000000', tokenId: 'shib-id' },
      ];
      const prices: PriceMap = { 'shib-id': '0.00001' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      // 1_000_000_000 * 0.00001 = 10_000
      expect(result.totalValue).toBe('10000');
    });

    it('should handle very large prices', () => {
      const holdings: MockHolding[] = [{ tokenSymbol: 'BTC', balance: '0.001', tokenId: 'btc-id' }];
      const prices: PriceMap = { 'btc-id': '100000' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      expect(result.totalValue).toBe('100');
    });
  });
});

/**
 * The metadata half of the service, against the real database.
 *
 * A EUR-base user's holding is priced through a USD-cached CoinGecko price,
 * and its time and source come from the same `PriceReader` answer. They were
 * once a separate lookup that fell back to *manual* prices only, so those
 * holdings came back with no `priceTimestamp` and `HoldingQueryService`
 * dropped them — every crypto and equity row on /holdings printed its value,
 * its gain, and "—" for its price (SC-66 / D-1).
 */
describe('PortfolioValuationService (integration — price metadata)', () => {
  interface MetadataFixture {
    userId: string;
    baseId: string;
    tokenIds: string[];
    assetId: string;
    freshId: string;
    tokenTypeId: string;
    institutionId: string;
    institutionTypeId: string;
    accountTypeId: string;
  }

  let fixture: MetadataFixture;
  const suffix = randomUUID().slice(0, 6);

  async function makeToken(typeId: string, symbol: string): Promise<Token> {
    const [token] = await db
      .insert(schema.tokens)
      .values({ symbol, name: symbol, typeId })
      .returning();
    if (!token) throw new Error(`token insert failed: ${symbol}`);
    return token;
  }

  beforeAll(async () => {
    const [tokenType] = await db
      .insert(schema.tokenTypes)
      .values({ code: `pvs-${suffix}`, name: 'PVS Token Type' })
      .returning();
    if (!tokenType) throw new Error('token type insert failed');

    // EUR-like base, USD-like quote, and an asset priced against the quote —
    // the exact shape of a European user holding CoinGecko-priced crypto.
    const base = await makeToken(tokenType.id, `PVSEUR${suffix.toUpperCase()}`);
    const quote = await makeToken(tokenType.id, `PVSUSD${suffix.toUpperCase()}`);
    const asset = await makeToken(tokenType.id, `PVSBTC${suffix.toUpperCase()}`);
    // A second asset whose only difference is when it was last quoted, so the
    // staleness assertion below has both arms on one fixture (SC-956).
    const fresh = await makeToken(tokenType.id, `PVSETH${suffix.toUpperCase()}`);

    const [user] = await db
      .insert(schema.users)
      .values({
        email: `pvs-${randomUUID().slice(0, 8)}@scani.local`,
        name: 'PVS User',
        baseCurrencyId: base.id,
      })
      .returning();
    if (!user) throw new Error('user insert failed');

    const [institutionType] = await db
      .insert(schema.institutionTypes)
      .values({ code: `pvs-inst-${suffix}`, name: 'PVS Institution Type' })
      .returning();
    const [institution] = await db
      .insert(schema.institutions)
      .values({ name: 'PVS Exchange', typeId: institutionType!.id })
      .returning();
    const [accountType] = await db
      .insert(schema.accountTypes)
      .values({ code: `pvs-acct-${suffix}`, name: 'PVS Account Type' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        userId: user.id,
        institutionId: institution!.id,
        name: 'PVS Account',
        typeId: accountType!.id,
      })
      .returning();

    await seedHoldingCache(db, (calculator) =>
      calculator.insert(schema.holdings).values([
        {
          userId: user.id,
          accountId: account!.id,
          tokenId: asset.id,
          balance: '2',
        },
        {
          userId: user.id,
          accountId: account!.id,
          tokenId: fresh.id,
          balance: '1',
        },
        // Cash in the base currency, which also has an old quote of its own
        // against another currency (SC-1447).
        {
          userId: user.id,
          accountId: account!.id,
          tokenId: base.id,
          balance: '100',
        },
      ])
    );

    // The provider row: priced in the QUOTE currency, not the user's base.
    //
    // Its timestamp is FIXED and in the past, so it is past the intraday
    // window and stays past it — age only grows. The row beside it is stamped
    // at fixture time, so it is inside the window and stays inside it. Neither
    // arm can flip with the wall clock, which is what makes the pair a test
    // rather than a snapshot of the day it was written.
    await db.insert(schema.tokenPrices).values([
      {
        tokenId: asset.id,
        baseTokenId: quote.id,
        price: '60000',
        timestamp: new Date('2026-08-13T06:00:00Z'),
        source: 'coingecko',
      },
      {
        tokenId: fresh.id,
        baseTokenId: quote.id,
        price: '3000',
        timestamp: new Date(),
        source: 'coingecko',
      },
      {
        tokenId: base.id,
        baseTokenId: quote.id,
        price: '1.08',
        timestamp: new Date('2026-08-13T06:00:00Z'),
        source: 'frankfurter',
      },
      // The same rate, current: a route is stale when any leg is, so the
      // current arm needs a current FX leg as well as a current quote.
      {
        tokenId: base.id,
        baseTokenId: quote.id,
        price: '1.08',
        timestamp: new Date(),
        source: 'frankfurter',
      },
    ]);

    fixture = {
      userId: user.id,
      baseId: base.id,
      tokenIds: [base.id, quote.id, asset.id, fresh.id],
      assetId: asset.id,
      freshId: fresh.id,
      tokenTypeId: tokenType.id,
      institutionId: institution!.id,
      institutionTypeId: institutionType!.id,
      accountTypeId: accountType!.id,
    };

    // Redis is not part of this assertion; compute every time.
    Container.set(PortfolioValueCache, {
      getOrCompute: async (_key: string, factory: () => Promise<unknown>) => factory(),
      bust: async () => {},
    } as unknown as PortfolioValueCache);
    Container.set(PortfolioValuationService, new PortfolioValuationService());
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, fixture.userId));
    await db
      .delete(schema.tokenPrices)
      .where(inArray(schema.tokenPrices.tokenId, fixture.tokenIds));
    await db.delete(schema.tokens).where(inArray(schema.tokens.id, fixture.tokenIds));
    await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, fixture.tokenTypeId));
    await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, fixture.accountTypeId));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, fixture.institutionId));
    await db
      .delete(schema.institutionTypes)
      .where(eq(schema.institutionTypes.id, fixture.institutionTypeId));

    Container.set(PortfolioValueCache, new PortfolioValueCache());
    Container.set(PortfolioValuationService, new PortfolioValuationService());
  });

  test('a provider price cached in another currency still carries its timestamp and source', async () => {
    const portfolio = await Container.get(PortfolioValuationService).getUserPortfolioValue(
      fixture.userId
    );

    const holding = portfolio.holdings.find((h) => h.tokenId === fixture.assetId);
    expect(holding?.currentPrice).not.toBeNull();
    expect(holding?.priceSource).toBe('coingecko');
    expect(holding?.priceTimestamp?.toISOString()).toBe('2026-08-13T06:00:00.000Z');
  });

  /**
   * The half of the price metadata nothing computed until SC-956. The
   * timestamp was already on the wire and already rendered as "3 weeks ago";
   * what a reader could not get from it is whether three weeks is past the
   * window this kind of price is held to, because nothing on the screen names
   * the window.
   *
   * Both arms, on one valuation, because a one-armed assertion here cannot
   * separate "the rule ran and said no" from "the field is never populated".
   */
  test('a price past its freshness window is flagged, and a current one is not', async () => {
    const portfolio = await Container.get(PortfolioValuationService).getUserPortfolioValue(
      fixture.userId
    );

    const stale = portfolio.holdings.find((h) => h.tokenId === fixture.assetId);
    const current = portfolio.holdings.find((h) => h.tokenId === fixture.freshId);
    expect(stale?.priceStale).toBe(true);
    expect(current?.priceStale).toBe(false);
  });

  /**
   * SC-1447. A holding in the user's own base currency is 1 at every instant,
   * so no quote can make it stale — not even a stored row pricing that
   * currency against another one, which is what the metadata lookup finds and
   * dated. Beside the stale arm above, so a rule that flags nothing cannot
   * pass both.
   */
  test('a holding in the base currency is priced 1 and never stale, whatever rows exist for it', async () => {
    const portfolio = await Container.get(PortfolioValuationService).getUserPortfolioValue(
      fixture.userId
    );

    const cash = portfolio.holdings.find((h) => h.tokenId === fixture.baseId);
    expect(cash?.currentPrice).toBe('1');
    expect(cash?.priceStale).toBe(false);
    expect(cash?.priceSource).toBe('Base Currency');
    expect(portfolio.holdings.find((h) => h.tokenId === fixture.assetId)?.priceStale).toBe(true);
  });
});

describe('sumPortfolioDebtByAccount', () => {
  function portfolio(
    holdings: Array<{ accountId: string; value: string | null; isActive?: boolean }>
  ): PortfolioValueResult {
    return {
      totalValue: '0',
      baseCurrency: 'USD',
      holdings: holdings.map((h, index) => ({
        holdingId: `holding-${index}`,
        accountId: h.accountId,
        tokenId: `token-${index}`,
        tokenSymbol: `T${index}`,
        balance: h.value ?? '-1',
        currentPrice: h.value === null ? null : '1',
        value: h.value,
        isActive: h.isActive ?? true,
      })),
    };
  }

  test('sums only the negative holdings, per account', () => {
    const debt = sumPortfolioDebtByAccount(
      portfolio([
        { accountId: 'A', value: '10000' },
        { accountId: 'A', value: '-2500' },
        { accountId: 'B', value: '500' },
      ])
    );
    expect(debt.get('A')?.toString()).toBe('-2500');
    expect(debt.has('B')).toBe(false);
  });

  test('an unpriced or inactive negative holding is not debt', () => {
    const debt = sumPortfolioDebtByAccount(
      portfolio([
        { accountId: 'A', value: null },
        { accountId: 'C', value: '-300', isActive: false },
      ])
    );
    expect(debt.size).toBe(0);
  });

  test('no valuation, no debt', () => {
    expect(sumPortfolioDebtByAccount(null).size).toBe(0);
  });
});
