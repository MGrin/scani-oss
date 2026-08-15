import { useEffect, useState } from 'react';
import {
  LOADING_BANDS,
  type LoadingBands,
  type LoadingPhase,
  loadingPhaseAt,
} from '../lib/loading';

/**
 * The §2.5 ramp as React state — nothing before 300ms, an indicator to 1s, a
 * skeleton after that, and a stalled notice once the wait stops being credible.
 *
 * Every v3 query site goes through this, which is the whole point: the fix for
 * "a cached list flashes a skeleton" is not a better skeleton, it is one hook
 * that every surface calls so none of them can render a placeholder at 0ms.
 *
 * Timers rather than an interval and a clock: three `setTimeout`s that fire
 * once each cost nothing, where a tick would re-render the whole surface
 * several times a second for the entire wait. The bands are read as three
 * numbers rather than as an object so a call site passing an inline literal
 * does not reschedule on every render.
 */
export function useDelayedLoading(
  isLoading: boolean,
  bands: Partial<LoadingBands> = {}
): LoadingPhase {
  const indicatorAt = bands.indicator ?? LOADING_BANDS.indicator;
  const skeletonAt = bands.skeleton ?? LOADING_BANDS.skeleton;
  const stallAt = bands.stall ?? LOADING_BANDS.stall;

  const [phase, setPhase] = useState<LoadingPhase>('idle');

  useEffect(() => {
    if (!isLoading) {
      // Synchronous rather than deferred: data has arrived, and one extra
      // frame of skeleton over the top of it is the flash this hook exists
      // to remove.
      setPhase('idle');
      return;
    }
    const bandsAt = { indicator: indicatorAt, skeleton: skeletonAt, stall: stallAt };
    const startedAt = Date.now();
    // Each timer asks `loadingPhaseAt` what band the clock is actually in
    // rather than asserting its own. A tab that was backgrounded fires three
    // deadlines at once on return, and the honest answer to all three is the
    // band the elapsed time says — not a walk up through the two it skipped.
    const advance = () => setPhase(loadingPhaseAt(Date.now() - startedAt, bandsAt));
    const timers = [indicatorAt, skeletonAt, stallAt].map((at) => setTimeout(advance, at));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [isLoading, indicatorAt, skeletonAt, stallAt]);

  return phase;
}
