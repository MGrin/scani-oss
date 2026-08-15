import { describe, expect, test } from 'bun:test';
import { LOADING_BANDS, loadingPhaseAt } from '@scani/ui/v3/lib/loading';

/**
 * The three bands of §2.5 plus the stalled fallback. This is the whole timing
 * policy — `useDelayedLoading` is three `setTimeout`s around it — so the
 * boundaries are worth pinning here rather than discovering by watching a
 * skeleton.
 */

describe('loadingPhaseAt — the three-band ramp', () => {
  test('a settled query draws nothing', () => {
    expect(loadingPhaseAt(null)).toBe('idle');
  });

  /** The band that matters most: most cached tRPC reads land in it, and it is
   *  where v2 rendered five bars. */
  test('nothing at all below 300ms', () => {
    expect(loadingPhaseAt(0)).toBe('idle');
    expect(loadingPhaseAt(299)).toBe('idle');
  });

  test('an indicator from 300ms, when the layout is still unknown', () => {
    expect(loadingPhaseAt(300)).toBe('indicator');
    expect(loadingPhaseAt(999)).toBe('indicator');
  });

  test('a skeleton past a second, once the wait is long enough to furnish', () => {
    expect(loadingPhaseAt(1000)).toBe('skeleton');
    expect(loadingPhaseAt(9999)).toBe('skeleton');
  });

  /** A shimmer that runs forever asserts "any moment now" for as long as the
   *  tab is open. Past the stall band the placeholder stops animating and the
   *  interface says what it actually knows. */
  test('stalled once the wait stops being credible', () => {
    expect(loadingPhaseAt(10_000)).toBe('stalled');
    expect(loadingPhaseAt(600_000)).toBe('stalled');
  });

  test('the bands are ordered, so no elapsed time can skip one', () => {
    expect(LOADING_BANDS.indicator).toBeLessThan(LOADING_BANDS.skeleton);
    expect(LOADING_BANDS.skeleton).toBeLessThan(LOADING_BANDS.stall);
  });

  test('honours custom bands', () => {
    const bands = { indicator: 50, skeleton: 100, stall: 200 };
    expect(loadingPhaseAt(49, bands)).toBe('idle');
    expect(loadingPhaseAt(50, bands)).toBe('indicator');
    expect(loadingPhaseAt(100, bands)).toBe('skeleton');
    expect(loadingPhaseAt(200, bands)).toBe('stalled');
  });
});
