process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { GroupRepository } from '../../../src/repositories/GroupRepository';
import {
  GroupValuationService,
  type ValuableHolding,
} from '../../../src/services/portfolio/GroupValuationService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

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
 * `holdingId -> groupIds`: EFFECTIVE membership, which is what
 * `findGroupsForHoldings` returns — its own rows, plus what its account's
 * standing rule puts it in, minus anything vetoed (SC-386).
 */
type Membership = Record<string, string[]>;

/**
 * `findByUser` and `findGroupsForHoldings` are everything the service reads off
 * the repository; anything else would throw if it were touched. That is the
 * point of the shape — `findGroupsForHoldings` is also what
 * `holdings.getWithDetails` puts on the wire, so a stub of it stands in for
 * both surfaces at once.
 */
function makeService(groupIds: string[], membership: Membership): GroupValuationService {
  const stub = {
    findByUser: async () => groupIds.map((id) => ({ id, name: id, color: '#000000' })),
    findGroupsForHoldings: async (holdings: Array<{ id: string }>) =>
      new Map(
        holdings.map(({ id }) => [
          id,
          (membership[id] ?? []).map((groupId) => ({
            id: groupId,
            name: groupId,
            color: '#000000',
          })),
        ])
      ),
  } as unknown as GroupRepository;

  Container.set(GroupRepository, stub);
  const instance = new GroupValuationService();
  Container.set(GroupValuationService, instance);
  return instance;
}

const PRICES = new Map([
  ['AAPL', '200'],
  ['EUR', '1'],
  ['USD', '1'],
]);

/**
 * What `/holdings?group=<id>` shows underneath itself, computed the way the
 * frontend computes it: `V3DataView` filters on the row's own `groups`
 * (`holdingsConfig`'s `group` filter) and `HoldingsSummary` totals the rows the
 * filter left, skipping the ones that do not count (`holdingsValue`).
 *
 * Deliberately written out here rather than imported: the frontend is a
 * different workspace, and what has to be pinned is the arithmetic, not the
 * component.
 */
function holdingsListTotal(
  holdings: ValuableHolding[],
  membership: Membership,
  groupId: string,
  prices: Map<string, string>
): string {
  return holdings
    .filter((entry) => entry.holding.isActive)
    .filter((entry) => (membership[entry.holding.id] ?? []).includes(groupId))
    .reduce(
      (sum, entry) =>
        sum.add(new Decimal(entry.holding.balance).mul(prices.get(entry.token.symbol) ?? '0')),
      new Decimal(0)
    )
    .toString();
}

describe('GroupValuationService.valueByGroup', () => {
  /**
   * SC-385, and the reason this file has a second computation in it at all —
   * kept through SC-386, which reversed what the answer IS without splitting it
   * back into two answers.
   *
   * The dashboard's allocation card and the holdings list it opens are two
   * readings of one group, and they disagreed materially on production for
   * weeks because there were two membership resolutions. There is one now:
   * `GroupRepository.findGroupsForHoldings`, stubbed below, which is also what
   * `holdings.getWithDetails` puts on the wire. So this stub stands in for both
   * surfaces, and the two figures have to be EQUAL, not close.
   *
   * What changed under SC-386 is inside that one resolution: it returns
   * `(holding_groups ∪ the account's standing rule) − per-holding vetoes`, so
   * `h-new` — the Airwallex-shaped one, created after the account joined the
   * group — is in it. The card and the list BOTH move to the new figure. On
   * production Liquid's figure rises by what the account rule pulls in, which
   * is what the fixture spells out.
   */
  test('the card and the holdings list agree on every group, including on what the account rule pulls in', async () => {
    const membership: Membership = { h1: ['g1'], h2: ['g1', 'g2'], 'h-new': ['g1'] };
    const holdings = [
      holding('h1', 'acc', 'AAPL', '232.7765'),
      holding('h2', 'acc', 'EUR', '250'),
      // Airwallex USD, created 2026-06-28, in `g1` by its account's rule.
      holding('h-new', 'acc', 'USD', '6218.75'),
    ];
    const service = makeService(['g1', 'g2'], membership);

    const { groups, ungrouped } = await service.valueByGroup(USER, holdings, PRICES);

    for (const entry of groups) {
      expect([entry.group.id, entry.total.value]).toEqual([
        entry.group.id,
        holdingsListTotal(holdings, membership, entry.group.id, PRICES),
      ]);
    }
    // Stated absolutely as well, so the pairing cannot pass by both sides being
    // wrong in the same direction: the pre-existing total plus what the account
    // rule pulls in.
    expect(groups.map((entry) => entry.total.value)).toEqual(['53024.05', '250']);
    expect(ungrouped.value).toBe('0');
  });

  /**
   * The other half of the semantic: the rule is standing, so the only way a
   * holding in a grouped account leaves the group is a veto — and when one is
   * written, the money surface has to drop it exactly as the list does.
   */
  test('a holding vetoed out of its account rule counts in neither the group nor ungrouped twice', async () => {
    const membership: Membership = { keep: ['g1'], dust: [] };
    const holdings = [holding('keep', 'acc', 'USD', '147.82'), holding('dust', 'acc', 'USD', '0')];
    const service = makeService(['g1'], membership);

    const { groups, ungrouped } = await service.valueByGroup(USER, holdings, PRICES);

    expect(groups[0]?.total.value).toBe(holdingsListTotal(holdings, membership, 'g1', PRICES));
    expect(groups[0]?.total).toMatchObject({ value: '147.82', holdingsCounted: 1 });
    expect(ungrouped).toMatchObject({ value: '0', holdingsCounted: 1 });
  });

  test('a holding neither its own row nor its account puts in the group is in neither', async () => {
    const service = makeService(['g1'], { h1: ['g1'], h2: [] });

    const { groups, ungrouped } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'AAPL', '1'), holding('h2', 'acc', 'AAPL', '10')],
      PRICES
    );

    expect(groups[0]?.total).toMatchObject({ value: '200', holdingsCounted: 1 });
    expect(ungrouped).toMatchObject({ value: '2000', holdingsCounted: 1 });
  });

  /**
   * The defect this service was extracted to fix. The code it replaced kept ONE
   * set of already-counted holdings across every group, so a holding claimed by
   * the first group contributed nothing to a second that also claimed it — that
   * group's total was silently short by the whole position.
   */
  test('a holding reached by two groups counts fully in both', async () => {
    const service = makeService(['g1', 'g2'], { h1: ['g1', 'g2'] });

    const { groups } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'AAPL', '3')],
      PRICES
    );

    expect(groups.map((entry) => entry.total.value)).toEqual(['600', '600']);
  });

  /** A group deactivated under a holding leaves it in no *visible* group, which
   *  is what ungrouped means — not missing from every bucket. */
  test('a holding whose only group is inactive falls into ungrouped', async () => {
    const service = makeService(['g1'], { h1: ['gone'] });

    const { groups, ungrouped } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'AAPL', '2')],
      PRICES
    );

    expect(groups[0]?.total).toMatchObject({ value: '0', holdingsCounted: 0 });
    expect(ungrouped).toMatchObject({ value: '400', holdingsCounted: 1 });
  });

  test('an unpriceable position is named beside the total, never folded into it', async () => {
    const service = makeService(['g1'], { h1: ['g1'], h2: ['g1'] });

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
    const service = makeService(['g1'], { h1: ['g1'] });

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

  test('inactive holdings are excluded from the total and from ungrouped alike', async () => {
    const service = makeService(['g1'], { h1: ['g1'], h2: ['g1'], h3: [] });

    const { groups, ungrouped } = await service.valueByGroup(
      USER,
      [
        holding('h1', 'acc', 'AAPL', '1'),
        holding('h2', 'acc', 'AAPL', '10', false),
        holding('h3', 'acc', 'AAPL', '10', false),
      ],
      PRICES
    );

    expect(groups[0]?.total.value).toBe('200');
    expect(groups[0]?.total.holdingsCounted).toBe(1);
    expect(ungrouped).toMatchObject({ value: '0', holdingsCounted: 0 });
  });

  test('ungrouped is what no visible group claims', async () => {
    const service = makeService(['g1'], { h1: ['g1'], h2: [] });

    const { ungrouped } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'AAPL', '1'), holding('h2', 'other', 'EUR', '250')],
      PRICES
    );

    expect(ungrouped).toMatchObject({ groupId: 'ungrouped', value: '250', holdingsCounted: 1 });
  });
});
