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
 * SC-951. The reconciler's other residue — the hole INSIDE the covered window
 * — reaching a reader for the first time.
 *
 * Until this, `dataIntegrity` was the only thing the query service raised
 * about an unreconciled holding, and it is gated on
 * `opening_balance_quantity < 0`, which exactly one of the reconciler's four
 * actions ever writes. A residue on either positive branch was not
 * miscategorised: it had no surface at all, and a reader cannot be suspicious
 * of wording that does not exist.
 *
 * The two facts are read from two columns by two predicates on purpose, and
 * every test here is really about keeping them apart — see the mixed case at
 * the end, which is the one that would catch a merge of the two.
 */

interface Coverage {
  openingBalanceQuantity?: string | null;
  unexplainedResidual?: string | null;
  reconciliationNotes?: string | null;
}

function makeService(coverage: Coverage | null): HoldingQueryService {
  Container.set(HoldingRepository, {
    findByUserWithFullDetails: async () => [
      {
        holding: {
          id: 'holding-0',
          balance: '10',
          source: 'exchange',
          isHidden: false,
          isActive: true,
          lastUpdated: new Date('2026-08-14T00:00:00Z'),
          createdAt: new Date('2026-08-01T00:00:00Z'),
        },
        token: {
          id: 'token-0',
          symbol: 'TESTCOIN',
          name: 'Test token',
          typeName: 'Crypto',
          typeCode: 'crypto',
          iconUrl: null,
          isScamProbability: 0,
        },
        account: {
          id: 'account-0',
          name: 'Test account',
          typeName: 'Exchange',
          typeCode: 'exchange',
          institutionId: 'inst-0',
        },
        institution: {
          id: 'inst-0',
          name: 'Test venue',
          typeName: 'Exchange',
          typeCode: 'exchange',
          website: null,
        },
      },
    ],
  } as unknown as HoldingRepository);
  Container.set(PortfolioValuationService, {
    getUserPortfolioValue: async () => ({
      holdings: [
        {
          tokenSymbol: 'TESTCOIN',
          currentPrice: '2',
          priceTimestamp: new Date('2026-08-14T00:00:00Z'),
          priceSource: 'coingecko',
        },
      ],
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
    findManyByHoldingIds: async () =>
      coverage
        ? new Map([
            [
              'holding-0',
              {
                holdingId: 'holding-0',
                openingBalanceQuantity: null,
                unexplainedResidual: null,
                reconciliationNotes: null,
                historyStartsAt: null,
                ...coverage,
              },
            ],
          ])
        : new Map(),
  } as unknown as HoldingCoverageRepository);
  Container.set(TokenRepository, {
    findNeverPricedInCooldownTokenIds: async () => new Set<string>(),
  } as unknown as TokenRepository);

  const instance = new HoldingQueryService();
  Container.set(HoldingQueryService, instance);
  return instance;
}

const user = { id: 'user-1', baseCurrencyId: 'base-token' } as User;

describe('HoldingQueryService — the unexplained residue', () => {
  test('a persisted residue reaches the DTO as a figure', async () => {
    const service = makeService({ openingBalanceQuantity: '0', unexplainedResidual: '20' });
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.unexplainedResidual).toBe('20');
  });

  // Absent rather than null, the convention `unpriceable` states: the field is
  // an exception and the wire payload's shape says so.
  test('a holding with no residue carries no field at all', async () => {
    const service = makeService({ openingBalanceQuantity: '5' });
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.unexplainedResidual).toBeUndefined();
  });

  test('a holding with no coverage row at all carries no field', async () => {
    const service = makeService(null);
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.unexplainedResidual).toBeUndefined();
  });

  /**
   * The decision, asserted rather than remembered (mgrin, 2026-09-03): this is
   * a FACT, not a flag. `dataIntegrity` is what the data-quality panel and the
   * list badge key on, and a residue must not raise it — that is how a neutral
   * fact becomes a "worth looking into" count by accident, which would be
   * permanently wrong for the benign accrual that is the case actually firing
   * in production.
   */
  test('a residue alone raises no dataIntegrity flag', async () => {
    const service = makeService({ openingBalanceQuantity: '0', unexplainedResidual: '20' });
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.unexplainedResidual).toBe('20');
    expect(holding?.dataIntegrity).toBeUndefined();
  });

  /**
   * The control for the test above, and it is what makes that `toBeUndefined`
   * mean anything: the flag is still raised by the predicate that always
   * raised it. Without this the assertion above would also pass over a build
   * where `dataIntegrity` had stopped working entirely.
   */
  test('a negative opening still raises dataIntegrity, unchanged', async () => {
    const service = makeService({
      openingBalanceQuantity: '-100',
      reconciliationNotes: 'Missing inflows',
    });
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.dataIntegrity?.incompleteHistory).toBe(true);
    expect(holding?.dataIntegrity?.missingQuantity).toBe('-100');
    expect(holding?.unexplainedResidual).toBeUndefined();
  });

  /**
   * The reconciler never writes both today — the sign of one expression
   * decides which column is populated — so this is a statement about the
   * READER rather than about data that exists. Two facts stay two facts: the
   * day a writer does produce both, a surface that merged them would report
   * one number for two different questions.
   */
  test('both columns populated stay two separate facts', async () => {
    const service = makeService({
      openingBalanceQuantity: '-100',
      unexplainedResidual: '20',
      reconciliationNotes: 'Missing inflows',
    });
    const [holding] = await service.getHoldingsByAccountIdWithDetails(user);
    expect(holding?.dataIntegrity?.missingQuantity).toBe('-100');
    expect(holding?.unexplainedResidual).toBe('20');
  });
});
