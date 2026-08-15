/**
 * The loading *timing policy* of §2.5, as a pure function of elapsed time.
 *
 * Loading is not a component, it is a ramp with three bands:
 *
 * - **0–300ms — nothing.** Most cached tRPC reads land here. A skeleton that
 *   appears and disappears inside a third of a second reads as a glitch, and
 *   is strictly worse than the frame of nothing it replaced. v2's `DataView`
 *   rendered its bars at 0ms unconditionally, which is why a cached list
 *   flashed a placeholder it never needed.
 * - **300ms–1s — a subtle indicator.** Long enough that the tap has to be
 *   acknowledged, short enough that committing to a full skeleton would be a
 *   layout the user then watches get replaced.
 * - **beyond 1s — the skeleton**, shaped like the layout that is coming.
 *
 * And a fourth state the ramp needs but the brief's three bands do not name:
 * **stalled**. A shimmer that runs forever is a lie — it says "any moment
 * now" for as long as the tab is open. Past `stall` the placeholder stops
 * animating and says so.
 *
 * The bands live here rather than inside the hook so the boundaries are
 * checkable without a DOM, which is the only test environment this repo has.
 */

export type LoadingPhase = 'idle' | 'indicator' | 'skeleton' | 'stalled';

export interface LoadingBands {
  /** ms before anything at all is drawn. */
  indicator: number;
  /** ms before the indicator is promoted to a full skeleton. */
  skeleton: number;
  /** ms after which the wait is reported as stalled rather than animated. */
  stall: number;
}

export const LOADING_BANDS: LoadingBands = {
  indicator: 300,
  skeleton: 1000,
  stall: 10_000,
};

/**
 * `elapsedMs === null` means "not loading" — the caller has data, or never
 * asked. Every other value is milliseconds since the query started.
 *
 * Boundaries are inclusive on the upper band (`elapsed >= indicator` shows the
 * indicator) so a timer that fires exactly on its deadline lands in the band it
 * was scheduled for rather than one below it.
 */
export function loadingPhaseAt(
  elapsedMs: number | null,
  bands: LoadingBands = LOADING_BANDS
): LoadingPhase {
  if (elapsedMs === null) return 'idle';
  if (elapsedMs >= bands.stall) return 'stalled';
  if (elapsedMs >= bands.skeleton) return 'skeleton';
  if (elapsedMs >= bands.indicator) return 'indicator';
  return 'idle';
}
