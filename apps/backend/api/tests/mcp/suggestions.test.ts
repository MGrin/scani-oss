import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import { planRebalance, RebalanceInputError, suggest } from '../../src/mcp/suggestions';

// SC-1616: the arithmetic on top of the app's figures, without a database.

function holding(
  id: string,
  typeCode: string,
  symbol: string,
  value: number,
  costBasis: number,
  price: string
): HoldingWithDetails {
  return {
    id,
    value,
    costBasis,
    amount: String(value / Number(price)),
    isActive: true,
    isHidden: false,
    price: { value: price },
    label: null,
    token: { symbol, name: symbol, typeCode, type: typeCode, isScamProbability: 0 },
    account: { name: 'acct' },
  } as unknown as HoldingWithDetails;
}

const OPTS = { maxPositionPct: 100, maxCashPct: 100, minLossToHarvest: 0 };

describe('suggest (SC-1616)', () => {
  test('a loss at least the floor is a harvest idea; a smaller one is not', () => {
    const holdings = [
      holding('a', 'stock', 'AAA', 800, 1000, '8'),
      holding('b', 'stock', 'BBB', 95, 100, '1'),
      holding('c', 'crypto', 'CCC', 500, 100, '5'),
    ];
    const ideas = suggest(holdings, 'USD', { ...OPTS, minLossToHarvest: 10 }).ideas;
    const harvests = ideas.filter((i) => i.kind === 'harvest_loss');
    expect(harvests).toHaveLength(1);
    expect(harvests[0]).toMatchObject({
      holdingId: 'a',
      unrealisedGain: -200,
      unrealisedGainPct: -20,
    });
  });

  test('base-currency cash is never a trim, however large', () => {
    const holdings = [
      holding('cash', 'fiat', 'USD', 900, 900, '1'),
      holding('x', 'stock', 'X', 100, 100, '1'),
    ];
    const ideas = suggest(holdings, 'USD', { ...OPTS, maxPositionPct: 20 }).ideas;
    expect(ideas.filter((i) => i.kind === 'trim')).toEqual([]);
  });
});

describe('planRebalance (SC-1616)', () => {
  test('by holding: the trade carries a quantity at the holding price', () => {
    const holdings = [
      holding('a', 'stock', 'AAA', 750, 750, '25'),
      holding('b', 'stock', 'BBB', 250, 250, '10'),
    ];
    const plan = planRebalance(holdings, 'holding', [
      { key: 'a', percent: 50 },
      { key: 'b', percent: 50 },
    ]);
    const a = plan.rows.find((r) => r.key === 'a');
    expect(a).toMatchObject({ action: 'sell', tradeValue: 250, tradeQuantity: 10 });
  });

  test('drift within tolerance is a hold', () => {
    const holdings = [
      holding('a', 'stock', 'AAA', 520, 520, '1'),
      holding('b', 'crypto', 'BBB', 480, 480, '1'),
    ];
    const plan = planRebalance(
      holdings,
      'asset_type',
      [
        { key: 'stock', percent: 50 },
        { key: 'crypto', percent: 50 },
      ],
      5
    );
    expect(plan.rows.every((r) => r.action === 'hold')).toBe(true);
  });

  test('an unknown holding id is refused', () => {
    expect(() =>
      planRebalance([holding('a', 'stock', 'AAA', 1, 1, '1')], 'holding', [
        { key: 'zz', percent: 100 },
      ])
    ).toThrow(RebalanceInputError);
  });
});
