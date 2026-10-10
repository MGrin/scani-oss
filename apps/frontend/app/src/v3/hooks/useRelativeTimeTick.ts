import { useSyncExternalStore } from 'react';
import { createRelativeTimeTick } from '@/v3/lib/relative-time-tick';

const tick = createRelativeTimeTick();

/**
 * Re-render once a minute so the relative times this component shows stay
 * true. Call it in every component that renders `formatRelative` or
 * `occurredLabel`; `tests/v3/lib/relative-time-tick.test.ts` fails on one that
 * does not (SC-1599).
 */
export function useRelativeTimeTick(): void {
  // The server snapshot is the same clock: a static render shows the time it ran.
  useSyncExternalStore(tick.subscribe, tick.getSnapshot, tick.getSnapshot);
}
