import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  compareGroupAmounts,
  type GroupValue,
  groupAmount,
  groupCoverageLine,
  inactiveGroupNote,
  unpricedGroupNote,
} from '../../../src/v3/lib/groups';

/** The real `t`, so these assertions pin the English that `en.json` produces. */
const t = i18n.t.bind(i18n);

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
  /**
   * The sentence SC-388 was reported for said "the 22 active holdings in this
   * group" over a list of 36, which is a claim about the group and true only of
   * the total. Both numbers are in it now, so it cannot be read as either one
   * alone.
   */
  test('reconciles the figure against the list it sits above', () => {
    expect(groupCoverageLine(value({ holdingsCounted: 22 }), 36, t)).toBe(
      'Covers 22 of the 36 holdings listed below.'
    );
  });

  test('says so plainly when the figure covers everything listed', () => {
    expect(groupCoverageLine(value({ holdingsCounted: 4 }), 4, t)).toBe(
      'Covers all 4 holdings listed below.'
    );
    expect(groupCoverageLine(value({ holdingsCounted: 1 }), 1, t)).toBe(
      'Covers the 1 holding listed below.'
    );
  });

  /** Two queries feed this screen and either can land first. Until the list is
   *  there, there is nothing to reconcile against and the sentence says only
   *  what the total covers — never "covers 22 of the 0". */
  test('states the count alone while the list is still loading', () => {
    expect(groupCoverageLine(value({ holdingsCounted: 22 }), null, t)).toBe(
      'What the 22 holdings behind this total are worth today.'
    );
    expect(groupCoverageLine(value({ holdingsCounted: 1 }), null, t)).toBe(
      'What the 1 holding behind this total is worth today.'
    );
  });

  test('a group with nothing valued says so rather than claiming a total', () => {
    expect(groupCoverageLine(value({ holdingsCounted: 0 }), 3, t)).toBe(
      'Nothing in this group carries a value today.'
    );
    expect(groupCoverageLine(undefined, null, t)).toBe(
      'Nothing in this group carries a value today.'
    );
  });
});

describe('inactiveGroupNote', () => {
  test('an ordinary group says nothing', () => {
    expect(inactiveGroupNote(0, t)).toBeNull();
  });

  /** The row the list shows and the figure above it does not count. Until
   *  SC-388 the only trace of it was an arithmetic gap. */
  test('names how many of the listed rows the total leaves out', () => {
    expect(inactiveGroupNote(1, t)).toBe(
      '1 of them is inactive: it stays in the group and is listed below, but it is not in this total.'
    );
    expect(inactiveGroupNote(3, t)).toContain('3 of them are inactive');
  });
});

describe('unpricedGroupNote', () => {
  test('nothing unpriced says nothing', () => {
    expect(unpricedGroupNote([], t)).toBeNull();
  });

  test('names what is missing, and stops naming past three', () => {
    expect(unpricedGroupNote(['AAPL'], t)).toBe(
      'AAPL could not be priced today, so it is not in this total.'
    );
    expect(unpricedGroupNote(['AAPL', 'MSFT'], t)).toBe(
      'AAPL and MSFT could not be priced today, so they are not in this total.'
    );
    expect(unpricedGroupNote(['AAPL', 'MSFT', 'BTC', 'ETH'], t)).toBe(
      'AAPL, MSFT and 2 more could not be priced today, so they are not in this total.'
    );
  });
});
