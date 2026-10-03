import { describe, expect, test } from 'bun:test';
import type { User } from '@scani/db/schema';
import { Container } from 'typedi';
import { GroupRepository } from '../../../src/repositories/GroupRepository';
import { HoldingApyConfigRepository } from '../../../src/repositories/HoldingApyConfigRepository';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { PortfolioValueDailyRepository } from '../../../src/repositories/PortfolioValueDailyRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import {
  type BalanceRefreshability,
  BalanceRefreshabilityService,
} from '../../../src/services/holdings/BalanceRefreshabilityService';
import { HoldingQueryService } from '../../../src/services/holdings/HoldingQueryService';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

/**
 * R95: `refreshable` on the wire is the server's one answer, the same one the
 * `refreshBalance` refusal reads. `BalanceRefreshabilityService.test.ts` holds
 * the answer itself to F1 to F4; this holds the list to asking for it once and
 * shipping what it was told.
 */

const ANSWERS: BalanceRefreshability[] = [
  'refreshable',
  'no-live-sync',
  'not-a-feed',
  'sync-cannot-write',
];

interface Asked {
  id: string;
  kind: string | null;
  source: string;
  accountId: string;
}

function makeService(asked: Array<{ userId: string; holdings: Asked[] }>): HoldingQueryService {
  const fullDetails = ANSWERS.map((_answer, i) => ({
    holding: {
      id: `holding-${i}`,
      accountId: `account-${i}`,
      kind: 'feed',
      balance: '10',
      // Non-manual on every row, so nothing here can be read off the source.
      source: 'sync_exchange_balances',
      isHidden: false,
      isActive: true,
      lastUpdated: new Date('2026-10-03T00:00:00Z'),
      createdAt: new Date('2026-10-01T00:00:00Z'),
    },
    token: {
      id: `token-${i}`,
      symbol: `TOK${i}`,
      name: `Token ${i}`,
      typeName: 'Crypto',
      typeCode: 'crypto',
      iconUrl: null,
      isScamProbability: 0,
    },
    account: {
      id: `account-${i}`,
      name: 'Spot',
      typeName: 'Exchange',
      typeCode: 'exchange',
      institutionId: `inst-${i}`,
    },
    institution: {
      id: `inst-${i}`,
      name: 'Kraken',
      typeName: 'Exchange',
      typeCode: 'exchange',
      website: null,
    },
  }));

  Container.set(HoldingRepository, {
    findByUserWithFullDetails: async () => fullDetails,
  } as unknown as HoldingRepository);
  Container.set(BalanceRefreshabilityService, {
    forHoldings: async (userId: string, holdings: Asked[]) => {
      asked.push({ userId, holdings });
      return new Map(holdings.map((holding, i) => [holding.id, ANSWERS[i]]));
    },
  } as unknown as BalanceRefreshabilityService);
  Container.set(PortfolioValuationService, {
    getUserPortfolioValue: async () => ({ holdings: [] }),
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

describe('HoldingQueryService: refreshable on the wire', () => {
  test('is true only for a holding the server answers refreshable, whatever its source', async () => {
    const holdings = await makeService([]).getHoldingsByAccountIdWithDetails(user);
    expect(holdings.map((holding) => holding.refreshable)).toEqual([true, false, false, false]);
  });

  test('is asked once for the whole list, for the user whose list it is, with the kind, source and account of every holding', async () => {
    const asked: Array<{ userId: string; holdings: Asked[] }> = [];
    await makeService(asked).getHoldingsByAccountIdWithDetails(user);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.userId).toBe(user.id);
    expect(
      asked[0]?.holdings.map(({ id, kind, source, accountId }) => ({
        id,
        kind,
        source,
        accountId,
      }))
    ).toEqual(
      ANSWERS.map((_answer, i) => ({
        id: `holding-${i}`,
        kind: 'feed',
        source: 'sync_exchange_balances',
        accountId: `account-${i}`,
      }))
    );
  });
});
