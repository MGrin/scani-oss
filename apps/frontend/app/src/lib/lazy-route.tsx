import { ChunkErrorBoundary } from '@scani/ui/components/ChunkErrorBoundary';
import type { ChunkLoadState } from '@scani/ui/lib/lazy-chunk';
import { LoadingSpinner } from '@scani/ui/ui/loading';
import { type ComponentType, lazy, Suspense } from 'react';
import { chunkReloadSpent, loadChunkWithOneReload } from '@/lib/chunk-reload';
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
 * 1. **A second chance at the request**, which since SC-890 is one document
 *    reload rather than a retry loop. The usual chunk failure is a phone whose
 *    connection blinked and would serve it on the next ask — but there is no
 *    way to ask again from inside this page. A rejected dynamic import is
 *    recorded in the browser's **module map** under its resolved URL, and every
 *    later `import()` of that URL re-delivers the stored failure without
 *    touching the network. `importChunk` used to run three attempts against
 *    that and issued exactly one request; `lazy-chunk.ts` carries what was
 *    measured. Replacing the document is what gets a fresh module map — and,
 *    because it also re-fetches `index.html`, it is the only recovery that
 *    helps when the chunk is gone for the other reason, a new build having
 *    shipped while this tab was open. `chunk-reload.ts` owns the once-per-tab
 *    guard that keeps it from becoming a loop.
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
    default: await loadChunkWithOneReload(chunk, load),
  }));

  // Read once, at the same lifetime as the `lazy()` it describes, because
  // within one document it cannot change: SC-890 made the second attempt a
  // document RELOAD, so there is no transition here to subscribe to. The
  // store and `useSyncExternalStore` this replaces (SC-840) existed to watch
  // `importChunk`'s retry loop tick over, and that loop is gone — it issued no
  // second request. What carries the state across the reload instead is the
  // marker in `chunk-reload.ts`, which is the only thing that survives the
  // document being replaced.
  const state: ChunkLoadState = chunkReloadSpent(chunk)
    ? { phase: 'retrying', attempt: 2, failures: 1 }
    : { phase: 'loading', attempt: 1, failures: 0 };

  return function LazyRoute() {
    return (
      <ChunkErrorBoundary chunk={chunk} onError={(error) => void reportClientError({ error })}>
        <Suspense fallback={<RoutePendingFallback chunk={chunk} state={state} />}>
          <Loaded />
        </Suspense>
      </ChunkErrorBoundary>
    );
  };
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
 * the same picture — to a reader looking at the screen, and to the gate, which
 * read this element with `.count()` and threw the name away. A spinner that
 * means "this is arriving" and one that means "a fetch of this has already
 * failed" want opposite responses, and the second one is not fixed by waiting
 * longer.
 *
 * **SC-890 changed what the middle row measures.** It read `phase=retrying
 * failures>0` off `importChunk`'s retry loop, and that loop issued no second
 * request — so the number counted attempts that never reached the network, and
 * the window it described was 750 ms of backoff rather than a fetch. The second
 * attempt is now a document reload, so the same two attributes now say
 * something stronger and simpler: **`failures=1` means one fetch genuinely
 * failed and this document is the retry.** A gate that reads `retrying` is
 * looking at a page that has already been reloaded once for this chunk.
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
