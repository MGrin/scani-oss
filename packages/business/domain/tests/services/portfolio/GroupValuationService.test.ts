process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
  return {
    holding: { id, accountId, balance, isActive },
    token: { id: `token-${symbol}`, symbol },
  };
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

// Keyed on TOKEN ID, which is what `valueByGroup` looks a price up by — a
// symbol is not unique (SC-1114). `holding()` above mints `token-<symbol>`.
const PRICES = new Map([
  ['token-AAPL', '200'],
  ['token-EUR', '1'],
  ['token-USD', '1'],
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
        sum.add(new Decimal(entry.holding.balance).mul(prices.get(entry.token.id) ?? '0')),
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

/**
 * SC-1128. A group of only closed positions headlined zero, so the valuation
 * now also reports what its INACTIVE holdings are worth. That figure is shown
 * only under an "Inactive value" label, and the guard below is that
 * nothing already on screen may move.
 */
describe('GroupValuationService — the inactive figure (SC-1128)', () => {
  test('a group of only inactive holdings reports their worth beside a zero total', async () => {
    const service = makeService(['g1'], { h1: ['g1'], h2: ['g1'], h3: ['g1'] });

    const { groups } = await service.valueByGroup(
      USER,
      [
        holding('h1', 'acc', 'AAPL', '2', false),
        holding('h2', 'acc', 'EUR', '50', false),
        holding('h3', 'acc', 'NOPRICE', '7', false),
      ],
      PRICES
    );

    expect(groups[0]?.total).toEqual({
      groupId: 'g1',
      value: '0',
      holdingsCounted: 0,
      unpricedSymbols: [],
      // 2 x 200 + 50 x 1. The unpriceable one is counted as a holding and
      // adds nothing: this figure makes no claim of completeness, it is shown
      // only as what the priced closed positions are worth.
      inactiveValue: '450',
      inactiveHoldings: 3,
    });
  });

  test('an inactive holding is placed by the same membership rule as an active one', async () => {
    const service = makeService(['g1', 'g2'], { h1: ['g2'], h2: [] });

    const { groups, ungrouped } = await service.valueByGroup(
      USER,
      [holding('h1', 'acc', 'AAPL', '1', false), holding('h2', 'acc', 'AAPL', '3', false)],
      PRICES
    );

    expect(groups.find((g) => g.group.id === 'g1')?.total.inactiveHoldings).toBe(0);
    expect(groups.find((g) => g.group.id === 'g2')?.total).toMatchObject({
      inactiveValue: '200',
      inactiveHoldings: 1,
    });
    expect(ungrouped).toMatchObject({ inactiveValue: '600', inactiveHoldings: 1 });
  });

  /**
   * THE GUARD. Every active field of every group and of `ungrouped` reads the
   * same whether or not the inactive holdings are in the input at all, which
   * is what the service returned before SC-1128 existed: it dropped them on
   * entry. A leak of the new sum into `value` fails here, on a mixed fixture
   * where it would move the figure.
   */
  test('the active figures are identical with and without the inactive holdings', async () => {
    const membership = { a1: ['g1'], a2: ['g1', 'g2'], i1: ['g1'], i2: ['g2'], a3: [], i3: [] };
    const active = [
      holding('a1', 'acc', 'AAPL', '1'),
      holding('a2', 'acc', 'EUR', '100'),
      holding('a3', 'other', 'NOPRICE', '4'),
    ];
    const inactive = [
      holding('i1', 'acc', 'AAPL', '9', false),
      holding('i2', 'acc', 'USD', '70', false),
      holding('i3', 'other', 'EUR', '5', false),
    ];
    const activeFields = (v: {
      value: string;
      holdingsCounted: number;
      unpricedSymbols: string[];
    }) => ({
      value: v.value,
      holdingsCounted: v.holdingsCounted,
      unpricedSymbols: v.unpricedSymbols,
    });

    const before = await makeService(['g1', 'g2'], membership).valueByGroup(USER, active, PRICES);
    const after = await makeService(['g1', 'g2'], membership).valueByGroup(
      USER,
      [...active, ...inactive],
      PRICES
    );

    expect(after.groups.map((g) => activeFields(g.total))).toEqual(
      before.groups.map((g) => activeFields(g.total))
    );
    expect(activeFields(after.ungrouped)).toEqual(activeFields(before.ungrouped));
    // The control: the inactive holdings did reach the service, or the
    // equality above would hold for the wrong reason.
    expect(after.groups.map((g) => g.total.inactiveHoldings)).toEqual([1, 1]);
  });

  test('execute passes the portfolio total through untouched', async () => {
    const service = makeService(['g1'], { h1: ['g1'], h2: ['g1'] });
    const stub = service as unknown as {
      portfolioService: { getUserPortfolioValue: () => Promise<unknown> };
      holdingRepository: { findByUserWithFullDetails: () => Promise<ValuableHolding[]> };
    };
    stub.portfolioService = {
      getUserPortfolioValue: async () => ({
        totalValue: '200',
        baseCurrency: 'USD',
        holdings: [{ tokenId: 'token-AAPL', balance: '1', value: '200' }],
      }),
    };
    stub.holdingRepository = {
      findByUserWithFullDetails: async () => [
        holding('h1', 'acc', 'AAPL', '1'),
        holding('h2', 'acc', 'AAPL', '5', false),
      ],
    };

    const result = await service.execute(USER);

    expect(result.totalValue).toBe('200');
    expect(result.groups[0]).toMatchObject({ value: '200', inactiveValue: '1000' });
  });

  /**
   * The portfolio total and the weekly digest cannot move because they never
   * read this service: the digest reads the daily rollups, which
   * `RollupPortfolioValueDailyUseCase` writes from `PortfolioValuationService`.
   * Pinned as a fact about the source rather than left as a sentence here, so a
   * future import of group valuation into either path reddens this.
   */
  test('the portfolio total and the weekly digest do not read group valuation', () => {
    const root = new URL('../../../src/', import.meta.url).pathname;
    for (const file of [
      'services/portfolio/PortfolioValuationService.ts',
      'use-cases/RollupPortfolioValueDailyUseCase.ts',
      'services/digest/WeeklyDigestService.ts',
    ]) {
      expect({
        file,
        imports: readFileSync(root + file, 'utf8').includes('GroupValuationService'),
      }).toEqual({
        file,
        imports: false,
      });
    }
    // The control: the one path that DOES read it still says so.
    expect(
      readFileSync(`${root}services/portfolio/AssetAllocationService.ts`, 'utf8').includes(
        'GroupValuationService'
      )
    ).toBe(true);
  });
});
