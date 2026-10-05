import { describe, expect, test } from 'bun:test';
import { SCAM_PROBABILITY_THRESHOLD } from '../../src/lib/constants';
import {
  holdingCountsInTotal,
  holdingIsRolledUp,
  isIncludedInTotal,
} from '../../src/lib/holding-inclusion';

describe('isIncludedInTotal', () => {
  const visible = { isHidden: false, isActive: true };
  const cleanToken = { isScamProbability: 0 };

  test('a visible, active, non-scam holding is included', () => {
    expect(isIncludedInTotal(visible, cleanToken)).toBe(true);
  });

  test('a hidden holding is excluded', () => {
    expect(isIncludedInTotal({ isHidden: true, isActive: true }, cleanToken)).toBe(false);
  });

  test('an inactive holding is excluded', () => {
    expect(isIncludedInTotal({ isHidden: false, isActive: false }, cleanToken)).toBe(false);
  });

  test('a scam token at/above the threshold is excluded', () => {
    expect(isIncludedInTotal(visible, { isScamProbability: SCAM_PROBABILITY_THRESHOLD })).toBe(
      false
    );
  });

  test('a token just below the scam threshold is included', () => {
    expect(
      isIncludedInTotal(visible, { isScamProbability: SCAM_PROBABILITY_THRESHOLD - 0.01 })
    ).toBe(true);
  });
});

// SC-1486, mgrin 2026-10-02: a holding the OWNER hid counts nowhere; one the
// closed-position sweep hid still counts in value history, PnL, returns and
// flows. A hidden holding with no `hiddenBy` reads as the owner's.
describe('who hid it (SC-1486)', () => {
  const cleanToken = { isScamProbability: 0 };

  test('a holding the sweep hid still counts', () => {
    expect(
      isIncludedInTotal({ isHidden: true, isActive: true, hiddenBy: 'auto' }, cleanToken)
    ).toBe(true);
  });

  test('a holding its owner hid does not', () => {
    expect(
      isIncludedInTotal({ isHidden: true, isActive: true, hiddenBy: 'user' }, cleanToken)
    ).toBe(false);
  });

  test('a hidden holding nobody recorded is read as the owner’s', () => {
    expect(isIncludedInTotal({ isHidden: true, isActive: true, hiddenBy: null }, cleanToken)).toBe(
      false
    );
  });

  test('an inactive holding the sweep hid still does not count', () => {
    expect(
      isIncludedInTotal({ isHidden: true, isActive: false, hiddenBy: 'auto' }, cleanToken)
    ).toBe(false);
  });
});

// SC-1546: the rollup preloaded the visible holdings only, so a sweep-hidden
// one was valued by a pass that had never been handed its ledger.
describe('what the rollup lists (SC-1546)', () => {
  const every = [false, true].flatMap((isHidden) =>
    ([null, 'user', 'auto'] as const).flatMap((hiddenBy) =>
      [true, false].map((isActive) => ({ isHidden, hiddenBy, isActive }))
    )
  );

  test('every holding a total counts is listed', () => {
    expect(every.filter(holdingCountsInTotal).length).toBeGreaterThan(0);
    expect(every.filter((h) => holdingCountsInTotal(h) && !holdingIsRolledUp(h))).toEqual([]);
  });

  test('a holding the sweep hid is listed', () => {
    expect(holdingIsRolledUp({ isHidden: true, hiddenBy: 'auto', isActive: true })).toBe(true);
  });

  test('a holding its owner hid is not, whether or not anyone recorded who', () => {
    for (const hiddenBy of ['user', null] as const) {
      expect(holdingIsRolledUp({ isHidden: true, hiddenBy, isActive: true })).toBe(false);
      expect(holdingIsRolledUp({ isHidden: true, hiddenBy, isActive: false })).toBe(false);
    }
  });

  test('a visible inactive holding stays listed: it keeps a row of its own', () => {
    expect(holdingIsRolledUp({ isHidden: false, isActive: false })).toBe(true);
  });

  test('an inactive holding the sweep hid is not listed', () => {
    expect(holdingIsRolledUp({ isHidden: true, hiddenBy: 'auto', isActive: false })).toBe(false);
  });
});
