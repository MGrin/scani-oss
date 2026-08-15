import { describe, expect, test } from 'bun:test';
import {
  compareGroupAmounts,
  type GroupValue,
  groupAmount,
  groupCoverageLine,
  unpricedGroupNote,
} from '../../../src/v3/lib/groups';

function value(partial: Partial<GroupValue> = {}): GroupValue {
  return {
    groupId: 'g1',
    value: '1000',
    holdingsCounted: 2,
    unpricedSymbols: [],
    ...partial,
  };
}

describe('groupAmount', () => {
  test('a priced group reads its total', () => {
    expect(groupAmount(value())).toBe(1000);
  });

  /**
   * The distinction the whole figure rests on: an empty group is worth zero and
   * may say so, but a group whose every position is unpriceable is unknown, and
   * zero there understates it by its entire value.
   */
  test('an empty group is zero; one we could price nothing in is no figure at all', () => {
    expect(groupAmount(value({ value: '0', holdingsCounted: 0 }))).toBe(0);
    expect(
      groupAmount(value({ value: '0', holdingsCounted: 0, unpricedSymbols: ['AAPL'] }))
    ).toBeNull();
  });

  test('a group with no row yet has no figure rather than a zero that will move', () => {
    expect(groupAmount(undefined)).toBeNull();
  });
});

describe('compareGroupAmounts', () => {
  test('biggest first when descending', () => {
    expect(compareGroupAmounts(10, 20, 'desc')).toBeGreaterThan(0);
    expect(compareGroupAmounts(10, 20, 'asc')).toBeLessThan(0);
  });

  /** Unknown is not small: it sorts last whichever way the column is pointing,
   *  rather than leading an ascending sort as if it were zero. */
  test('an unpriced group sorts last in either direction', () => {
    expect(compareGroupAmounts(null, 20, 'desc')).toBeGreaterThan(0);
    expect(compareGroupAmounts(null, 20, 'asc')).toBeGreaterThan(0);
    expect(compareGroupAmounts(20, null, 'asc')).toBeLessThan(0);
    expect(compareGroupAmounts(null, null, 'desc')).toBe(0);
  });
});

describe('groupCoverageLine', () => {
  test('says how many holdings the figure is made of, singular spelled out', () => {
    expect(groupCoverageLine(value({ holdingsCounted: 1 }))).toBe(
      'What the 1 active holding in this group is worth today.'
    );
    expect(groupCoverageLine(value({ holdingsCounted: 4 }))).toContain('4 active holdings');
  });

  test('a group with nothing valued says so rather than claiming a total', () => {
    expect(groupCoverageLine(value({ holdingsCounted: 0 }))).toBe(
      'Nothing in this group carries a value today.'
    );
    expect(groupCoverageLine(undefined)).toBe('Nothing in this group carries a value today.');
  });
});

describe('unpricedGroupNote', () => {
  test('nothing unpriced says nothing', () => {
    expect(unpricedGroupNote([])).toBeNull();
  });

  test('names what is missing, and stops naming past three', () => {
    expect(unpricedGroupNote(['AAPL'])).toBe(
      'AAPL could not be priced today, so it is not in this total.'
    );
    expect(unpricedGroupNote(['AAPL', 'MSFT'])).toBe(
      'AAPL and MSFT could not be priced today, so they are not in this total.'
    );
    expect(unpricedGroupNote(['AAPL', 'MSFT', 'BTC', 'ETH'])).toBe(
      'AAPL, MSFT and 2 more could not be priced today, so they are not in this total.'
    );
  });
});
