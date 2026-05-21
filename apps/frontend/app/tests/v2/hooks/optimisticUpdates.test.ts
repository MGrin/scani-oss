import { describe, expect, test } from 'bun:test';
import type { HoldingsWithSummary, HoldingWithDetails } from '@scani/shared';
import {
  patchHoldingById,
  recountHoldingsSummary,
  removeHoldingsById,
  setTokenScamInHidden,
  setTokenScamInHoldings,
} from '../../../src/v2/hooks/optimisticUpdates';

function makeHolding(overrides: Partial<HoldingWithDetails> = {}): HoldingWithDetails {
  return {
    id: 'h1',
    token: {
      id: 't1',
      symbol: 'BTC',
      name: 'Bitcoin',
      type: 'crypto',
      typeCode: 'crypto',
      iconUrl: null,
      isScamProbability: 0,
    },
    amount: 1,
    value: 100,
    costBasis: 80,
    account: { id: 'a1', name: 'Acc', type: 'wallet', typeCode: 'wallet', institutionId: 'i1' },
    institution: { id: 'i1', name: 'Inst', type: 'self', typeCode: 'self', website: null },
    groups: [],
    lastUpdated: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    isActive: true,
    isHidden: false,
    source: 'manual',
    ...overrides,
  };
}

function makeData(holdings: HoldingWithDetails[]): HoldingsWithSummary {
  return { holdings, summary: recountHoldingsSummary(holdings) };
}

describe('recountHoldingsSummary', () => {
  test('counts total, active, and sums priceable active value', () => {
    const summary = recountHoldingsSummary([
      makeHolding({ id: 'a', value: 100, isActive: true }),
      makeHolding({ id: 'b', value: 50, isActive: true }),
      makeHolding({ id: 'c', value: 999, isActive: false }),
      makeHolding({ id: 'd', value: null, isActive: true }),
    ]);
    expect(summary.totalCount).toBe(4);
    expect(summary.activeCount).toBe(3);
    // 100 + 50; the inactive row and the unpriceable (null) row contribute 0.
    expect(summary.totalValue).toBe('150');
  });

  test('empty list yields zeroed summary', () => {
    expect(recountHoldingsSummary([])).toEqual({
      totalCount: 0,
      activeCount: 0,
      totalValue: '0',
    });
  });
});

describe('removeHoldingsById', () => {
  test('removes the given ids and recomputes the summary', () => {
    const data = makeData([
      makeHolding({ id: 'a', value: 100 }),
      makeHolding({ id: 'b', value: 50 }),
      makeHolding({ id: 'c', value: 25 }),
    ]);
    const next = removeHoldingsById(data, new Set(['b']));
    expect(next.holdings.map((h) => h.id)).toEqual(['a', 'c']);
    expect(next.summary.totalCount).toBe(2);
    expect(next.summary.totalValue).toBe('125');
  });

  test('is a no-op when no ids match', () => {
    const data = makeData([makeHolding({ id: 'a' })]);
    const next = removeHoldingsById(data, new Set(['missing']));
    expect(next.holdings).toHaveLength(1);
  });
});

describe('patchHoldingById', () => {
  test('patches amount and leaves other holdings untouched', () => {
    const data = makeData([
      makeHolding({ id: 'a', amount: 1 }),
      makeHolding({ id: 'b', amount: 2 }),
    ]);
    const next = patchHoldingById(data, 'a', { amount: 5 });
    expect(next.holdings.find((h) => h.id === 'a')?.amount).toBe(5);
    expect(next.holdings.find((h) => h.id === 'b')?.amount).toBe(2);
  });

  test('toggling isActive updates the active count', () => {
    const data = makeData([
      makeHolding({ id: 'a', value: 100, isActive: true }),
      makeHolding({ id: 'b', value: 40, isActive: true }),
    ]);
    const next = patchHoldingById(data, 'b', { isActive: false });
    expect(next.summary.activeCount).toBe(1);
    expect(next.summary.totalValue).toBe('100');
  });

  test('an undefined patch field does not wipe the existing value', () => {
    const data = makeData([makeHolding({ id: 'a', amount: 7, isActive: true })]);
    const next = patchHoldingById(data, 'a', { amount: undefined, isActive: false });
    const row = next.holdings[0];
    expect(row?.amount).toBe(7);
    expect(row?.isActive).toBe(false);
  });
});

describe('setTokenScamInHoldings', () => {
  test('sets probability on every row holding the token, leaving the summary intact', () => {
    const data = makeData([
      makeHolding({ id: 'a', token: { ...makeHolding().token, id: 'scam' } }),
      makeHolding({ id: 'b', token: { ...makeHolding().token, id: 'safe' } }),
    ]);
    const next = setTokenScamInHoldings(data, 'scam', 1);
    expect(next.holdings.find((h) => h.id === 'a')?.token.isScamProbability).toBe(1);
    expect(next.holdings.find((h) => h.id === 'b')?.token.isScamProbability).toBe(0);
    expect(next.summary).toEqual(data.summary);
  });
});

describe('setTokenScamInHidden', () => {
  test('updates the scam probability on matching hidden rows', () => {
    const hidden = [
      {
        id: 'h1',
        balance: '1',
        source: 'manual',
        hiddenReason: 'scam' as const,
        token: { id: 'scam', symbol: 'X', name: 'X', iconUrl: null, isScamProbability: 1 },
        account: { id: 'a1', name: 'Acc' },
        institution: { id: 'i1', name: 'Inst' },
      },
    ];
    const next = setTokenScamInHidden(hidden, 'scam', 0);
    expect(next[0]?.token.isScamProbability).toBe(0);
  });
});
