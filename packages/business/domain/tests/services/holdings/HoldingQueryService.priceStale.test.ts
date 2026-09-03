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
 * SC-956. `PortfolioValuationService` decides whether a price is past its
 * freshness window; this is the wire between that decision and the list, the
 * summary caption and the peek sentence that read it.
 *
 * The interesting case is the THIRD state. `undefined` means no `token_prices`
 * row dated this price, so the question could not be asked — and if that
 * arrives at the client as `false` the reader is told the quote is current on
 * the strength of a check nobody ran.
 */

interface Row {
  symbol: string;
  price: string | null;
  /** What the valuation decided, `undefined` for "could not be asked". */
  stale: boolean | undefined;
  /** Makes this row the user's base currency, which prices itself at 1. */
  isBase?: boolean;
}

const BASE_TOKEN_ID = 'base-token';

function makeService(rows: Row[]): HoldingQueryService {
  const tokenIdOf = (row: Row, i: number) => (row.isBase ? BASE_TOKEN_ID : `token-${i}`);

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
      id: tokenIdOf(row, i),
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
        // The base-currency row is the one case with no `token_prices` row of
        // its own — the valuation carries no metadata for it, which is what
        // sends `HoldingQueryService` down its own fallback.
        priceTimestamp: row.price && !row.isBase ? new Date('2026-08-14T00:00:00Z') : null,
        priceSource: row.price && !row.isBase ? 'coingecko' : null,
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

const user = { id: 'user-1', baseCurrencyId: BASE_TOKEN_ID } as User;

describe('HoldingQueryService — the stale-price flag', () => {
  test('a holding valued from an old quote reaches the wire flagged', async () => {
    const service = makeService([{ symbol: 'THIN', price: '4.2', stale: true }]);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.priceStale).toBe(true);
    // The value is still there, and still a number. Flagging rather than
    // dropping is the decision the rollup already made and wrote down.
    expect(holding?.value).toBe(42);
  });

  test('a holding valued from a current quote is judged, and says so', async () => {
    const service = makeService([{ symbol: 'BTC', price: '62817', stale: false }]);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.priceStale).toBe(false);
  });

  /**
   * The state that must not be compressed. `false` says we asked and the quote
   * is current; `undefined` says nothing dated the price. Rendering the second
   * as the first is the failure this repository keeps writing down — an
   * absence arriving as good news.
   */
  test('an undated price stays undefined rather than collapsing to "current"', async () => {
    const service = makeService([{ symbol: 'ODD', price: '1.5', stale: undefined }]);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.priceStale).toBeUndefined();
  });

  /**
   * The base currency has no `token_prices` row against itself, so it takes
   * `HoldingQueryService`'s own fallback and the valuation's flag never
   * reaches it. A currency against itself is 1 at every instant: not old, and
   * not unknown either.
   */
  test('the base currency is never stale and never unknown', async () => {
    const service = makeService([{ symbol: 'EUR', price: null, stale: undefined, isBase: true }]);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.price?.source).toBe('Base Currency');
    expect(holding?.priceStale).toBe(false);
  });
});
