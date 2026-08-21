import { ChunkErrorBoundary } from '@scani/ui/components/ChunkErrorBoundary';
import { importChunk } from '@scani/ui/lib/lazy-chunk';
import { LoadingSpinner } from '@scani/ui/ui/loading';
import { type ComponentType, lazy, Suspense } from 'react';
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
  const Loaded = lazy(async () => ({
    default: await importChunk(load, { chunk }),
  }));

  return function LazyRoute() {
    return (
      <ChunkErrorBoundary chunk={chunk} onError={(error) => void reportClientError({ error })}>
        <Suspense
          fallback={
            // `data-route-pending` is the only signal that this route is still
            // a network request. The shell is never split (see above), so
            // `[data-ui="v3"]` is on screen from the first paint and says
            // nothing about whether the route under it has arrived — which is
            // how the visual gate photographed this spinner and filed it as
            // the home screen's baseline (SC-473). Anything waiting for a
            // routed screen waits for this attribute to go away.
            <div
              data-route-pending={chunk}
              className="flex min-h-screen items-center justify-center"
            >
              <LoadingSpinner />
            </div>
          }
        >
          <Loaded />
        </Suspense>
      </ChunkErrorBoundary>
    );
  };
}
