import { describe, expect, test } from 'bun:test';
import type { User } from '@scani/db/schema';
import { Container } from 'typedi';
import { GroupRepository } from '../../../src/repositories/GroupRepository';
import { HoldingApyConfigRepository } from '../../../src/repositories/HoldingApyConfigRepository';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { PortfolioValueDailyRepository } from '../../../src/repositories/PortfolioValueDailyRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { HoldingQueryService } from '../../../src/services/holdings/HoldingQueryService';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';

/**
 * SC-154. `value === null` is two facts wearing one face — "we could not
 * price this today" and "no source has ever quoted this token and we have
 * stopped asking" — and the list rendered the same dash for both. SC-146
 * taught the chart to say how many it set aside; this says which.
 */

interface Row {
  symbol: string;
  /** Present in the valuation result, i.e. we managed to price it. */
  price: string | null;
}

function makeService(rows: Row[], unpriceableTokenIds: string[]): HoldingQueryService {
  const fullDetails = rows.map((row, i) => ({
    holding: {
      id: `holding-${i}`,
      balance: '10',
      source: 'blockchain',
      isHidden: false,
      isActive: true,
      lastUpdated: new Date('2026-08-14T00:00:00Z'),
      createdAt: new Date('2026-08-01T00:00:00Z'),
    },
    token: {
      id: `token-${i}`,
      symbol: row.symbol,
      name: `${row.symbol} token`,
      typeName: 'Crypto',
      typeCode: 'crypto',
      iconUrl: null,
      isScamProbability: 0,
    },
    account: {
      id: `account-${i}`,
      name: 'Wallet',
      typeName: 'Wallet',
      typeCode: 'wallet',
      institutionId: `inst-${i}`,
    },
    institution: {
      id: `inst-${i}`,
      name: 'Ethereum',
      typeName: 'Chain',
      typeCode: 'chain',
      website: null,
    },
  }));

  Container.set(HoldingRepository, {
    findByUserWithFullDetails: async () => fullDetails,
  } as unknown as HoldingRepository);
  Container.set(PortfolioValuationService, {
    getUserPortfolioValue: async () => ({
      holdings: rows.map((row) => ({
        tokenSymbol: row.symbol,
        currentPrice: row.price,
        priceTimestamp: row.price ? new Date('2026-08-14T00:00:00Z') : null,
        priceSource: row.price ? 'coingecko' : null,
      })),
    }),
  } as unknown as PortfolioValuationService);
  Container.set(PortfolioValueDailyRepository, {
    findLatestHoldingCostBasis: async () => new Map(),
  } as unknown as PortfolioValueDailyRepository);
  Container.set(GroupRepository, {
    findGroupsForHoldings: async () => new Map(),
  } as unknown as GroupRepository);
  Container.set(HoldingApyConfigRepository, {
    findByHoldingIds: async () => new Map(),
  } as unknown as HoldingApyConfigRepository);
  Container.set(HoldingCoverageRepository, {
    findManyByHoldingIds: async () => new Map(),
  } as unknown as HoldingCoverageRepository);
  Container.set(TokenRepository, {
    findNeverPricedInCooldownTokenIds: async () => new Set(unpriceableTokenIds),
  } as unknown as TokenRepository);

  const instance = new HoldingQueryService();
  Container.set(HoldingQueryService, instance);
  return instance;
}

const user = { id: 'user-1', baseCurrencyId: 'base-token' } as User;

describe('HoldingQueryService — the unpriceable flag', () => {
  test('a holding with no price and a cooldown is flagged', async () => {
    const service = makeService([{ symbol: 'SPAM', price: null }], ['token-0']);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.value).toBeNull();
    expect(holding?.unpriceable).toBe(true);
  });

  // The ordinary case, and by far the common one. The flag is an exception —
  // it is absent rather than `false` so the wire payload stays the shape it
  // was for the 186 rows out of 200 that price fine.
  test('a priced holding carries no flag at all', async () => {
    const service = makeService([{ symbol: 'BTC', price: '62817' }], []);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.unpriceable).toBeUndefined();
  });

  /**
   * The distinction the badge exists to draw. A transient fetch failure also
   * lands as `value === null`, and calling that permanent would be the same
   * class of overclaim the dash already was.
   */
  test('an unpriced holding that is NOT in cooldown is left unlabelled', async () => {
    const service = makeService([{ symbol: 'BTC', price: null }], []);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.value).toBeNull();
    expect(holding?.unpriceable).toBeUndefined();
  });

  /**
   * The predicate self-heals: the day a provider finally quotes the token, the
   * backfill writes a price row and the cooldown lapses. Between those two
   * moments the token is in the cooldown set AND has a price, and the number is
   * on screen — so there is nothing to explain.
   */
  test('a token still in cooldown that we managed to price is not flagged', async () => {
    const service = makeService([{ symbol: 'RECOVERED', price: '0.004' }], ['token-0']);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.value).not.toBeNull();
    expect(holding?.unpriceable).toBeUndefined();
  });

  test('only the unpriceable rows in a mixed portfolio are flagged', async () => {
    const service = makeService(
      [
        { symbol: 'BTC', price: '62817' },
        { symbol: 'SPAM', price: null },
        { symbol: 'ETH', price: '1877' },
      ],
      ['token-1']
    );
    const holdings = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holdings.map((h) => h.unpriceable)).toEqual([undefined, true, undefined]);
  });
});
