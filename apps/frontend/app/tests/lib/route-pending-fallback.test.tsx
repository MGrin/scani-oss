import { describe, expect, test } from 'bun:test';
import type { ChunkLoadState } from '@scani/ui/lib/lazy-chunk';
import { LoadingSpinner } from '@scani/ui/ui/loading';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoutePendingFallback } from '../../src/lib/lazy-route';

/**
 * That the spinner says which of three things it is standing for (SC-840).
 *
 * ## The defect, and why a rendering test is the right shape for it
 *
 * A route chunk can be in three situations, and until this ticket two of them
 * were the same DOM and the same picture:
 *
 *     the first request is in flight          arriving  — wait
 *     fetches have FAILED, backing off        erroring  — waiting will not help
 *     it failed for good                      ChunkErrorBoundary's card
 *
 * Only the third was ever distinguishable, so a reader saw a spinner that meant
 * "this may never arrive" and read it as "this is arriving". The visual gate had
 * exactly the same problem one level up, and spent four runs unable to say what
 * it had photographed.
 *
 * **SC-890 changed where the middle row comes from.** SC-840 drove it from
 * `importChunk`'s retry loop, and that loop issued no second request — so the
 * state it reported described 750 ms of backoff between two attempts that never
 * reached the network. The second attempt is now a document reload, so the
 * middle row is seeded from `chunk-reload.ts`'s marker, which is the only thing
 * that survives the document being replaced. The tests for that source live in
 * `chunk-reload.test.ts`; what stays here is the rendering, which is unchanged
 * and is what the e2e parser reads.
 *
 * So the property under test is **that two different situations produce two
 * different markups**, not that a spinner renders. A test asserting only that
 * the fallback draws a spinner passes against the defect, because the defect
 * always drew one.
 *
 * ## Why the fallback is exported
 *
 * It is markup that exists only while something is unfinished, which makes it
 * the markup least reachable any other way — the same reason `ChunkLoadFallback`
 * next door is exported "for its own test". Rendering it against a state
 * directly is what lets both arms be driven without a network.
 *
 * `apps/e2e/visual/route-pending.ts` parses these three attributes and is what
 * turns them into the gate's verdict. If this file goes red, that parser is
 * reading attributes that are no longer there and its `unknown` fallback will
 * quietly absorb it — which is the failure this pins.
 */

function markup(state: ChunkLoadState, chunk = 'interface'): string {
  return renderToStaticMarkup(createElement(RoutePendingFallback, { chunk, state }));
}

describe('RoutePendingFallback', () => {
  test('still carries the chunk name in data-route-pending', () => {
    // Unchanged on purpose: `settle()` waits for `[data-route-pending]` to
    // detach and the wait predates this ticket. Breaking the attribute would
    // make every screen photograph its spinner again (SC-473).
    expect(markup({ phase: 'loading', attempt: 1, failures: 0 })).toContain(
      'data-route-pending="interface"'
    );
  });

  test('a chunk that is arriving and one that has FAILED do not render the same', () => {
    const arriving = markup({ phase: 'loading', attempt: 1, failures: 0 });
    const erroring = markup({ phase: 'retrying', attempt: 2, failures: 1 });

    expect(arriving).toContain('data-route-pending-phase="loading"');
    expect(arriving).toContain('data-route-pending-failures="0"');
    expect(erroring).toContain('data-route-pending-phase="retrying"');
    expect(erroring).toContain('data-route-pending-failures="1"');
    // The whole point, stated as one assertion: these were one observation.
    expect(arriving).not.toBe(erroring);
  });

  test('nothing a reader can see changed, so no baseline moves', () => {
    // Three data attributes on an element that was already there. The visual
    // gate asserts 12 committed screenshots at maxDiffPixels: 0, and a fix that
    // reddened them would be paid for with an `--update` — which is how a
    // spinner became a baseline in the first place.
    const stripped = markup({ phase: 'retrying', attempt: 3, failures: 2 }).replace(
      /\sdata-route-pending(-[a-z]+)?="[^"]*"/g,
      ''
    );
    // The real spinner is rendered rather than its markup written out, so this
    // compares the fallback against the component it actually uses and cannot
    // pass by agreeing with a stale copy of it.
    const bare = renderToStaticMarkup(
      createElement(
        'div',
        { className: 'flex min-h-screen items-center justify-center' },
        createElement(LoadingSpinner)
      )
    );
    expect(stripped).toBe(bare);
  });
});
