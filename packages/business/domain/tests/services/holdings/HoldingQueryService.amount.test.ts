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
 * SC-567 — what `amount` carries on the wire.
 *
 * It was `new Decimal(holding.balance).toDecimalPlaces(8).toNumber()`, and
 * that lost BOTH ends of the range. Any balance under `1e-8` arrived as `0` —
 * not a rounding of a small position but a different claim, that it is empty —
 * and a double quietly dropped the low digits of a large one. Four surfaces
 * repeated the first: the list, the peek, the phone row and the CSV export an
 * accountant reads. The balance editor then wrote it back.
 *
 * NOTHING IN THIS SUITE COULD SEE ANY OF IT. Every fixture in this directory
 * used `balance: '10'`, so the rounding had never once been executed in a
 * test — a balance that survives rounding cannot test a rounder. The rows
 * below are the ones mgrin actually holds, plus a large one for the other end.
 */

interface Row {
  symbol: string;
  /** The stored balance, verbatim — this is what the test is about. */
  balance: string;
}

function makeService(rows: Row[]): HoldingQueryService {
  const fullDetails = rows.map((row, i) => ({
    holding: {
      id: `holding-${i}`,
      balance: row.balance,
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
        currentPrice: '1',
        priceTimestamp: new Date('2026-08-14T00:00:00Z'),
        priceSource: 'coingecko',
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

/** The two balances from production, plus each end of what a double can hold. */
const DUST = '0.0000000004013';
const SMALLEST = '0.000000000000000001';
const ORDINARY = '143.59019742';
const LARGE = '123456789012345.12345678';

describe('HoldingQueryService — the balance on the wire', () => {
  test.each([
    [DUST, 'the 4.013e-10 ETH position'],
    [SMALLEST, 'a one-wei STETH position'],
    [ORDINARY, 'an ordinary balance carrying 8 decimals'],
    [LARGE, 'a balance with more significant digits than a double holds'],
  ])('sends %s verbatim (%s)', async (balance) => {
    const service = makeService([{ symbol: 'TOK', balance }]);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.amount).toBe(balance);
  });

  /**
   * THE CLAIM THE BUG MADE, asserted directly so it can never be made again.
   * `0` is not a rounding of `0.0000000004013`; it says the position is empty,
   * and it said so on four surfaces at once.
   */
  test('a dust balance is never reported as zero', async () => {
    const service = makeService([
      { symbol: 'ETH', balance: DUST },
      { symbol: 'STETH', balance: SMALLEST },
    ]);
    const holdings = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holdings.map((h) => h.amount)).toEqual([DUST, SMALLEST]);
    expect(holdings.some((h) => Number(h.amount) === 0)).toBe(false);
  });

  /**
   * The other end, which the ticket did not name and which was losing digits
   * with nothing said. A double holds ~15-17 significant digits; this balance
   * has 23, and `toNumber()` returned `123456789012345.12`.
   */
  test('a large balance keeps the digits a double would have dropped', async () => {
    const service = makeService([{ symbol: 'TOK', balance: LARGE }]);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.amount).toBe(LARGE);
    // Non-vacuous: this is what the old implementation produced.
    expect(String(Number(LARGE))).not.toBe(LARGE);
  });

  /**
   * The normalisation, and the reason it is `toFixed()` rather than the column
   * verbatim: an exponent in the payload reaches a spreadsheet cell, where it
   * is text to some readers and a number to none.
   */
  test('an exponent in the stored balance is normalised away', async () => {
    const service = makeService([{ symbol: 'TOK', balance: '1e-18' }]);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.amount).toBe(SMALLEST);
  });
});
