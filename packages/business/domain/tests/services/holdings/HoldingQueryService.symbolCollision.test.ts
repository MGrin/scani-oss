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
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-1114 — two tokens can carry the same symbol, so a symbol is not an
 * identity and a price may not be keyed on one.
 *
 * `PortfolioValuationService` prices per token id and is correct at every
 * step. The consumer used to re-key its three lookups — price, source and
 * staleness — on `tokenSymbol`, and `new Map()` over an array of pairs keeps
 * the LAST duplicate, so both holdings rendered the survivor's numbers while
 * the total (computed upstream, per id) stayed right. The list and the total
 * could therefore disagree with nothing saying so.
 *
 * The pair below is a custom `private-company` token and a crypto token
 * sharing a symbol, which is the shape that occurs: a user names a token for a
 * company and a listed coin already trades under that ticker. Two orders are
 * asserted because which row survives a collision is decided by the holdings
 * query's iteration order — incidental, so a test fixing one order would pass
 * on half the defect.
 *
 * Symbols, names and figures here are invented.
 */

interface Row {
  tokenId: string;
  symbol: string;
  price: string;
  source: string;
  stale: boolean;
}

/** A manually-priced custom token and a listed coin under one symbol. */
const CUSTOM: Row = {
  tokenId: 'token-custom',
  symbol: 'ZZQ',
  price: '1500',
  source: 'manual',
  stale: false,
};
const LISTED: Row = {
  tokenId: 'token-listed',
  symbol: 'ZZQ',
  price: '0.25',
  source: 'coingecko',
  stale: true,
};

function makeService(rows: Row[]): HoldingQueryService {
  const fullDetails = rows.map((row, i) => ({
    holding: {
      id: `holding-${i}`,
      balance: '2',
      source: 'manual',
      isHidden: false,
      isActive: true,
      lastUpdated: new Date('2026-08-14T00:00:00Z'),
      createdAt: new Date('2026-08-01T00:00:00Z'),
    },
    token: {
      id: row.tokenId,
      symbol: row.symbol,
      name: `${row.symbol} ${i}`,
      typeName: 'Crypto',
      typeCode: 'crypto',
      iconUrl: null,
      isScamProbability: 0,
    },
    account: {
      id: `account-${i}`,
      name: 'Account',
      typeName: 'Wallet',
      typeCode: 'wallet',
      institutionId: `inst-${i}`,
    },
    institution: {
      id: `inst-${i}`,
      name: 'Venue',
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
        tokenId: row.tokenId,
        tokenSymbol: row.symbol,
        currentPrice: row.price,
        priceTimestamp: new Date('2026-08-14T00:00:00Z'),
        priceSource: row.source,
        priceStale: row.stale,
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
    findNeverPricedInCooldownTokenIds: async () => new Set<string>(),
  } as unknown as TokenRepository);

  const instance = new HoldingQueryService();
  Container.set(HoldingQueryService, instance);
  return instance;
}

const user = { id: 'user-1', baseCurrencyId: 'base-token' } as User;

describe('HoldingQueryService — two tokens under one symbol', () => {
  for (const [label, rows] of [
    ['custom first', [CUSTOM, LISTED]],
    ['listed first', [LISTED, CUSTOM]],
  ] as const) {
    test(`each holding keeps its own price, source and staleness (${label})`, async () => {
      const service = makeService([...rows]);
      const holdings = await service.getHoldingsByAccountIdWithDetails(user);
      const byTokenId = new Map(holdings.map((h) => [h.token.id, h]));

      const custom = byTokenId.get(CUSTOM.tokenId);
      expect(custom?.price?.value).toBe(CUSTOM.price);
      expect(custom?.price?.source).toBe(CUSTOM.source);
      expect(custom?.priceStale).toBe(CUSTOM.stale);
      // balance 2 at 1500. Asserted as well as the unit price, because the
      // value is what a reader actually sees and it is a second consumer of
      // the same map.
      expect(custom?.value).toBe(3000);

      const listed = byTokenId.get(LISTED.tokenId);
      expect(listed?.price?.value).toBe(LISTED.price);
      expect(listed?.price?.source).toBe(LISTED.source);
      expect(listed?.priceStale).toBe(LISTED.stale);
      expect(listed?.value).toBe(0.5);
    });
  }

  /**
   * The guard, rather than a third case: whatever else changes, no two rows
   * may end up sharing a price. Stated separately because the assertions
   * above would still pass if a future change made both rows resolve to the
   * SAME correct-looking value by coincidence of the fixture.
   */
  test('the two rows do not collapse onto one price', async () => {
    const service = makeService([CUSTOM, LISTED]);
    const holdings = await service.getHoldingsByAccountIdWithDetails(user);
    const prices = holdings.map((h) => h.price?.value);
    expect(new Set(prices).size).toBe(2);
  });
});
