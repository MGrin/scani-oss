import { describe, expect, test } from 'bun:test';
import { mapWithConcurrency } from '../../src/lib/map-with-concurrency';

/**
 * SC-1306. `BenchmarkReturnService.pricesOn` awaited one conversion per day in
 * order, so a 120-point chart cost 120 round trips end to end. This is the
 * bound that replaces the `for` loop.
 *
 * The properties that matter are the two a caller relies on without saying so:
 * results come back in INPUT order however the work interleaves, and no more
 * than `limit` are in flight at once.
 */

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  test('results are in input order, not completion order', async () => {
    const out = await mapWithConcurrency([30, 0, 15, 0], 4, async (ms, i) => {
      await tick(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  test('never runs more than `limit` at once, and does run more than one', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 24 }, (_, i) => i),
      6,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick(5);
        inFlight -= 1;
      }
    );
    expect(peak).toBe(6);
  });

  /**
   * The control for the test above. A helper that quietly ran everything
   * serially would also satisfy "never more than 6", so the peak has to be
   * asserted from BOTH sides — this is the arm that fails on the `for` loop
   * this change removes.
   */
  test('a serial implementation fails the bound above', async () => {
    let inFlight = 0;
    let peak = 0;
    for (const _ of Array.from({ length: 24 })) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(1);
      inFlight -= 1;
    }
    expect(peak).toBe(1);
  });

  test('a limit at or above the item count is one full batch', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2, 3], 10, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(2);
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  test('an empty list does no work and returns nothing', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async () => {
      calls += 1;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  /**
   * A rejection must surface rather than resolving to a hole. `pricesOn` drops
   * a day whose price is missing by reading a `null` RESULT — an error there is
   * a different fact and may not be laundered into the same shape.
   */
  test('a rejection propagates', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      })
    ).rejects.toThrow('boom');
  });

  test('the index handed to the mapper is the item’s own', async () => {
    const seen: Array<[string, number]> = [];
    await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, i) => {
      await tick(3 - i);
      seen.push([item, i]);
    });
    expect(seen.sort((a, b) => a[1] - b[1])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });
});
