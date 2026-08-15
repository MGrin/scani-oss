process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { GroupRepository } from '../../../src/repositories/GroupRepository';
import {
  GroupValuationService,
  type ValuableHolding,
} from '../../../src/services/portfolio/GroupValuationService';

// Stubs leak across files because typedi's Container is process-global —
// restore the real instances so a later test in the same run resolves them.
afterAll(() => {
  Container.set(GroupRepository, new GroupRepository());
  Container.set(GroupValuationService, new GroupValuationService());
});

const USER = 'user-1';

function holding(
  id: string,
  accountId: string,
  symbol: string,
  balance: string,
  isActive = true
): ValuableHolding {
  return { holding: { id, accountId, balance, isActive }, token: { symbol } };
}

/**
 * `findByUser` plus the two membership tables are everything the service reads
 * off the repository; anything else would throw if it were touched.
 */
function makeService(
  groupIds: string[],
  holdingsByGroup: Record<string, string[]>,
  accountsByGroup: Record<string, string[]>
): GroupValuationService {
  const stub = {
    findByUser: async () => groupIds.map((id) => ({ id, name: id, color: '#000000' })),
    getHoldingsByGroupIds: async () => new Map(Object.entries(holdingsByGroup)),
    getAccountsByGroupIds: async () => new Map(Object.entries(accountsByGroup)),
  } as unknown as GroupRepository;

  Container.set(GroupRepository, stub);
  const instance = new GroupValuationService();
  Container.set(GroupValuationService, instance);
  return instance;
}

const PRICES = new Map([
  ['AAPL', '200'],
  ['EUR', '1'],
]);

describe('GroupValuationService.valueByGroup', () => {
  test('a holding in a group both directly and through its account is counted once', async () => {
    const service = makeService(['g1'], { g1: ['h1'] }, { g1: ['acc'] });

    const { groups } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'AAPL', '3')],
      PRICES
    );

    expect(groups[0]?.total.value).toBe('600');
    expect(groups[0]?.total.holdingsCounted).toBe(1);
  });

  /**
   * The defect this service was extracted to fix. The code it replaced kept ONE
   * set of already-counted holdings across every group, so a holding claimed
   * directly by the first group contributed nothing to a second group that
   * reached it through an account — that group's total was silently short by
   * the whole position.
   */
  test('a holding reached by two groups counts fully in both', async () => {
    const service = makeService(['g1', 'g2'], { g1: ['h1'] }, { g2: ['acc'] });

    const { groups } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'AAPL', '3')],
      PRICES
    );

    expect(groups.map((entry) => entry.total.value)).toEqual(['600', '600']);
  });

  test('an unpriceable position is named beside the total, never folded into it', async () => {
    const service = makeService(['g1'], { g1: ['h1', 'h2'] }, {});

    const { groups } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'AAPL', '2'), holding('h2', 'acc', 'MYSTERY', '5')],
      PRICES
    );

    expect(groups[0]?.total).toMatchObject({
      value: '400',
      holdingsCounted: 1,
      unpricedSymbols: ['MYSTERY'],
    });
  });

  /** Zero of anything is worth zero in every currency, so it needs no price and
   *  is not a gap in the figure. */
  test('a zero balance is counted rather than reported as unpriceable', async () => {
    const service = makeService(['g1'], { g1: ['h1'] }, {});

    const { groups } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'MYSTERY', '0')],
      PRICES
    );

    expect(groups[0]?.total).toMatchObject({
      value: '0',
      holdingsCounted: 1,
      unpricedSymbols: [],
    });
  });

  test('inactive holdings are excluded from the total and from the account path', async () => {
    const service = makeService(['g1'], { g1: ['h1'] }, { g1: ['acc'] });

    const { groups } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'AAPL', '1'), holding('h2', 'acc', 'AAPL', '10', false)],
      PRICES
    );

    expect(groups[0]?.total.value).toBe('200');
    expect(groups[0]?.total.holdingsCounted).toBe(1);
  });

  test('ungrouped is what no group reaches, by either path', async () => {
    const service = makeService(['g1'], { g1: ['h1'] }, {});

    const { ungrouped } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'AAPL', '1'), holding('h2', 'other', 'EUR', '250')],
      PRICES
    );

    expect(ungrouped).toMatchObject({ groupId: 'ungrouped', value: '250', holdingsCounted: 1 });
  });
});
