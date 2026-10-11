/**
 * One shared clock for relative times. `formatRelative` reads `Date.now()`
 * only when a component renders, so "5m ago" stayed "5m ago" for as long as
 * nothing else re-rendered it (SC-1599). Every subscriber shares one interval,
 * which runs only while something on screen subscribes.
 */

interface Scheduler {
  set: (tick: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const browserScheduler: Scheduler = {
  set: (tick, ms) => setInterval(tick, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A minute is the smallest step `formatRelative` shows past "just now". */
const TICK_MS = 60_000;

export function createRelativeTimeTick(scheduler: Scheduler = browserScheduler) {
  const listeners = new Set<() => void>();
  let now = Date.now();
  let handle: unknown = null;

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        handle = scheduler.set(() => {
          now = Date.now();
          for (const notify of listeners) notify();
        }, TICK_MS);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && handle !== null) {
          scheduler.clear(handle);
          handle = null;
        }
      };
    },
    getSnapshot: (): number => now,
  };
}
