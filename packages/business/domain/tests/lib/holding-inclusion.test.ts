import { describe, expect, test } from 'bun:test';
import { SCAM_PROBABILITY_THRESHOLD } from '../../src/lib/constants';
import { isIncludedInTotal } from '../../src/lib/holding-inclusion';

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
