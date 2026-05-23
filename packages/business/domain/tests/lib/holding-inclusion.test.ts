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
