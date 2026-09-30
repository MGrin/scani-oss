import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { niceAxis } from '../../../src/v3/lib/nice-axis';

/**
 * SC-1424: the net-worth axis spanned exactly the data's min and max, so its
 * ticks printed whatever those happened to be — "£200.9K £205.9K … £220.2K",
 * with a last step shorter than the rest. These are the demo persona's 1W and
 * 1Y series as measured in the SC-1421 audit.
 */
describe('the net-worth axis lands on round values (SC-1424)', () => {
  test('1W, £200,892 to £220,220: £5K steps from £200K, every step equal', () => {
    const axis = niceAxis([208_796.94, 207_281.43, 220_220.31, 200_892.16]);
    expect(axis?.ticks).toEqual([200_000, 205_000, 210_000, 215_000, 220_000, 225_000]);
    expect(axis?.domain).toEqual([200_000, 225_000]);
  });

  test('1Y, £101,600 to £220,220: round steps, and the line still fits inside', () => {
    const axis = niceAxis([101_600, 150_000, 220_220.31]);
    expect(axis?.ticks).toEqual([100_000, 150_000, 200_000, 250_000]);
  });

  test('every tick is a whole multiple of one step', () => {
    for (const values of [
      [1_433, 1_462],
      [0.4, 0.9],
      [2_500_000, 2_540_000],
      [-3_200, 9_900],
    ]) {
      const axis = niceAxis(values);
      if (!axis) throw new Error(`no axis for ${values}`);
      const step = axis.ticks[1]! - axis.ticks[0]!;
      for (const [i, tick] of axis.ticks.entries()) {
        expect(tick).toBeCloseTo(axis.ticks[0]! + i * step, 9);
      }
      expect(axis.domain[0]).toBeLessThanOrEqual(Math.min(...values));
      expect(axis.domain[1]).toBeGreaterThanOrEqual(Math.max(...values));
    }
  });

  test('a first holding moving $1,433 to $1,462 still gets distinct ticks (SC-1138)', () => {
    const ticks = niceAxis([1_433, 1_462])?.ticks ?? [];
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });

  test('nothing to scale — no data, or a flat line — is left to the chart', () => {
    expect(niceAxis([])).toBeNull();
    expect(niceAxis([null, null])).toBeNull();
    expect(niceAxis([5_000, 5_000])).toBeNull();
  });
});
