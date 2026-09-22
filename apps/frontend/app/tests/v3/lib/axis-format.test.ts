import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import { resolveNumeric } from '@scani/ui/v3/lib/numeric';
import { axisFormat } from '../../../src/v3/lib/axis-format';

function labels(min: number, max: number): string[] {
  const format = axisFormat([min, max]);
  return [0, 1, 2, 3, 4].map(
    (i) => resolveNumeric(min + ((max - min) * i) / 4, { currency: 'USD', ...format }).text
  );
}

describe('a currency axis names each tick differently', () => {
  test('a first holding moving $1,433 to $1,462, the case the new-user walk found', () => {
    const ticks = labels(1_433, 1_462);
    expect(new Set(ticks).size).toBe(5);
    // Whole dollars, not thousands to three decimals.
    expect(ticks[0]).toBe('$1,433');
  });

  test('the control: compact alone collapses the same ticks', () => {
    const ticks = [0, 1, 2, 3, 4].map(
      (i) => resolveNumeric(1_433 + (29 * i) / 4, { currency: 'USD', compact: true }).text
    );
    expect(new Set(ticks).size).toBeLessThan(5);
  });

  test.each([
    [120_000, 124_000],
    [1_200_000, 1_204_000],
    [50_000, 90_000],
  ])('%d to %d stays distinct', (min, max) => {
    expect(new Set(labels(min, max)).size).toBe(5);
  });
});

describe('axisFormat', () => {
  test('plain compact when one decimal already separates the ticks', () => {
    expect(axisFormat([50_000, 90_000])).toEqual({ compact: true });
  });

  test('plain compact below a thousand, on a flat series and with no data', () => {
    expect(axisFormat([10, 900])).toEqual({ compact: true });
    expect(axisFormat([1_500, 1_500])).toEqual({ compact: true });
    expect(axisFormat([])).toEqual({ compact: true });
  });

  test('millions take decimals of the unit, never more than three', () => {
    expect(axisFormat([1_200_000, 1_204_000])).toEqual({ compact: true, decimals: 3 });
    expect(axisFormat([1_000_000, 1_000_001])).toEqual({ compact: true, decimals: 3 });
  });
});
