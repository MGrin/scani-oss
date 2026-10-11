import { describe, expect, test } from 'bun:test';
import { coverageQualityOf } from '../../src/lib/coverage-quality';

describe('coverageQualityOf (D-13)', () => {
  test('nothing priceable is unknown, whatever else the day holds', () => {
    expect(
      coverageQualityOf({ withKnownValue: 0, total: 0, unpriceable: 0, degraded: false })
    ).toBe('unknown');
    expect(coverageQualityOf({ withKnownValue: 0, total: 3, unpriceable: 3, degraded: true })).toBe(
      'unknown'
    );
  });

  test('95% of the priceable holdings valued is full, and partial when any is degraded', () => {
    const counts = { withKnownValue: 19, total: 21, unpriceable: 1 };
    expect(coverageQualityOf({ ...counts, degraded: false })).toBe('full');
    expect(coverageQualityOf({ ...counts, degraded: true })).toBe('partial');
  });

  test('unpriceable dust leaves the denominator', () => {
    expect(
      coverageQualityOf({ withKnownValue: 55, total: 69, unpriceable: 14, degraded: false })
    ).toBe('full');
  });

  test('between half and 95% is estimated, degraded or not', () => {
    expect(
      coverageQualityOf({ withKnownValue: 18, total: 20, unpriceable: 0, degraded: false })
    ).toBe('estimated');
    expect(
      coverageQualityOf({ withKnownValue: 10, total: 20, unpriceable: 0, degraded: true })
    ).toBe('estimated');
  });

  test('under half is unknown', () => {
    expect(
      coverageQualityOf({ withKnownValue: 9, total: 20, unpriceable: 0, degraded: false })
    ).toBe('unknown');
  });
});
