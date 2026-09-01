import { ChunkErrorBoundary } from '@scani/ui/components/ChunkErrorBoundary';
import { type ChunkLoadState, importChunk } from '@scani/ui/lib/lazy-chunk';
import { LoadingSpinner } from '@scani/ui/ui/loading';
import { type ComponentType, lazy, Suspense, useSyncExternalStore } from 'react';
import { reportClientError } from '@/lib/report-client-error';

/**
 * A route that arrives on its own, with the two things a route split needs to
 * be safe on a phone.
 *
 * **This file is the sanctioned exception to the repo's top-level-import rule**
 * (see `CLAUDE.md`). Route-level splitting in `apps/frontend/*` is the one place
 * `import()` is permitted, because it is the one place it buys something
 * measurable: SC-132 measured 4183 ms to first interactive control on a cold
 * Slow 4G load with **0 ms** of main-thread blocking, which makes bytes the
 * whole cost, and v2 and v3 both shipped to every reader while only one of them
 * ever ran.
 *
 * The two things:
 *
 * 1. **Retries**, via `importChunk`. The usual chunk failure is a phone whose
 *    connection blinked, and it succeeds on the next attempt.
 * 2. **A boundary above the split**, via `ChunkErrorBoundary`. Each generation
 *    carries its own error boundary, but those are *inside* the chunk and
 *    cannot catch it failing to arrive. Without one out here the failure is an
 *    unhandled rejection in render — a white screen with no way out, which in
 *    an installed PWA has no URL bar to escape from either (SC-62, SC-73).
 *
 * The spinner is the shell's, not a skeleton of the page: **the shell itself is
 * never split.** Auth, the tab-bar-owning generation shells, the theme and token
 * layer and the error boundaries all load eagerly, so what a reader waits for
 * here is one screen appearing, not an interface assembling itself in pieces.
 */
export function lazyRoute(chunk: string, load: () => Promise<ComponentType>): ComponentType {
  // Created once, outside render. A `lazy()` built during render is a new
  // component type on every pass, which remounts the tree it wraps.
  //
  // The store sits here for the same reason and shares that lifetime: the fetch
  // runs outside React entirely, so the fallback needs somewhere to read its
  // progress from that survives a render. One per chunk, like the `lazy()` it
  // describes.
  let state: ChunkLoadState = { phase: 'loading', attempt: 1, failures: 0 };
  const listeners = new Set<() => void>();
  const read = (): ChunkLoadState => state;
  const subscribe = (notify: () => void): (() => void) => {
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  };

  const Loaded = lazy(async () => ({
    default: await importChunk(load, {
      chunk,
      onState: (next) => {
        // A fresh object each time, which is what `useSyncExternalStore`
        // compares on: mutating the existing one would leave the snapshot
        // referentially equal and the fallback would never re-render.
        state = next;
        for (const notify of listeners) notify();
      },
    }),
  }));

  return function LazyRoute() {
    return (
      <ChunkErrorBoundary chunk={chunk} onError={(error) => void reportClientError({ error })}>
        <Suspense fallback={<RoutePending chunk={chunk} subscribe={subscribe} read={read} />}>
          <Loaded />
        </Suspense>
      </ChunkErrorBoundary>
    );
  };
}

/** Subscribes the fallback to its own chunk's progress. Split from the markup
 *  so `RoutePendingFallback` can be rendered against a state directly — a
 *  fallback is markup that only exists while something is unfinished, which is
 *  exactly the markup hardest to reach any other way. Same reasoning as
 *  `ChunkLoadFallback` next door. */
function RoutePending({
  chunk,
  subscribe,
  read,
}: {
  chunk: string;
  subscribe: (notify: () => void) => () => void;
  read: () => ChunkLoadState;
}) {
  return <RoutePendingFallback chunk={chunk} state={useSyncExternalStore(subscribe, read, read)} />;
}

/**
 * The spinner, and — since SC-840 — what it is a spinner *for*.
 *
 * `data-route-pending` is unchanged and still carries the chunk name: it is the
 * only signal that this route is still a network request, because the shell is
 * never split, so `[data-ui="v3"]` is on screen from the first paint and says
 * nothing about whether the route under it has arrived. That is how the visual
 * gate photographed this spinner and filed it as the home screen's baseline
 * (SC-473), and anything waiting for a routed screen still waits for this
 * attribute to go away.
 *
 * **What SC-840 adds is why it is still here**, and the reason it is worth two
 * attributes is that a bare marker made three different situations one
 * observation:
 *
 *     the first request is in flight          phase=loading  failures=0
 *     fetches have FAILED and it is retrying  phase=retrying failures>0
 *     it failed for good                      no [data-route-pending] at all,
 *                                             ChunkLoadFallback's card instead
 *
 * Only the third was ever distinguishable. The first two were the same DOM and
 * the same picture for the whole of `importChunk`'s backoff — to a reader
 * looking at the screen, and to the gate, which read this element with
 * `.count()` and threw the name away. A spinner that means "this is arriving"
 * and one that means "two fetches of this have already failed" want opposite
 * responses, and the second one is not fixed by waiting longer.
 *
 * Nothing here is rendered: three data attributes on the element that was
 * already there, so no baseline moves and no reader sees a change.
 */
export function RoutePendingFallback({ chunk, state }: { chunk: string; state: ChunkLoadState }) {
  return (
    <div
      data-route-pending={chunk}
      data-route-pending-phase={state.phase}
      data-route-pending-failures={state.failures}
      className="flex min-h-screen items-center justify-center"
    >
      <LoadingSpinner />
    </div>
  );
}
