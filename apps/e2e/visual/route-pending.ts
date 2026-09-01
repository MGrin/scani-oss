import type { Page } from '@playwright/test';

/**
 * Telling the two spinners apart (SC-840).
 *
 * The visual gate photographs a centred spinner for at least two unrelated
 * reasons, and until this module existed all three of its exits said the same
 * thing about them:
 *
 *     A  the SPA full-reloaded mid-run    document loads, module-graph write
 *     B  a route chunk was still pending  NO document load, cause unestablished
 *
 * A is SC-499 and its mechanism is measured — Vite broadcasts `full-reload`,
 * the client calls `location.reload()` silently, and the reloaded document is
 * the shell and a spinner. B is what four consecutive SC-825 runs hit, on four
 * different screens, and it is **not** A.
 *
 * They produced the same picture, and — the part that made them one bug for a
 * month — the same sentence. `assertPhotographedOnce`'s route-pending branch is
 * reachable only when `loads.count <= 1`, because the branch above it throws on
 * anything higher; so it fires exactly when A did **not** happen, and it cited
 * SC-499. It was written inside SC-499's own commit (`e66a4024c`) and inherited
 * that ticket's citation along with its code.
 *
 * ## Why this is a module and not a better string
 *
 * `playwright.visual.config.ts` sets `trace: 'off'`, `video: 'off'`,
 * `screenshot: 'off'`. **The sentence is the whole diagnostic surface** — there
 * is no trace to open afterwards and no frame to look at. So the sentence has
 * to carry the evidence that selected it, and the selection has to be a
 * function of that evidence rather than a constant chosen when the file was
 * written. That is what `describeSpinner` is: it names A or B from the load
 * count, and prints the count either way, including in the branch where the
 * count is what rules A out.
 */

/**
 * A route chunk that has not arrived, as the DOM reports it.
 *
 * `chunk` alone was in the DOM before this ticket and the spec read it with
 * `.count()`, throwing the name away — which mattered, because `lazy()`
 * memoises: a fallback that appears *after* one detached is either a different
 * chunk (the app navigated) or the same `lazy()` re-suspending (a new component
 * identity). The name is what separates those, and it was already there.
 */
export interface PendingRoute {
  chunk: string;
  /** `loading` — a request is in flight. `retrying` — the last one REJECTED and
   *  `importChunk` is backing off before the next. See `phase` on the DOM. */
  phase: string;
  /** How many fetches have already failed. `0` is the ordinary case. */
  failures: number;
}

/**
 * The route chunk's Suspense fallback, and the reason the shell alone is not a
 * readiness check (SC-473).
 *
 * v3 splits its routes and deliberately does **not** split the shell, so
 * `[data-ui="v3"]` is on screen from the first paint whether or not the screen
 * under it has downloaded. Home lost that race where the other four screens won
 * it, and the first `home-phone` baseline generated was a picture of a centred
 * spinner — which the gate would then have asserted forever, going green on a
 * screen it had never seen. `lazy-route.tsx` marks the fallback for this wait;
 * `detached` also passes instantly when the chunk was already cached and the
 * fallback never mounted.
 */
export const ROUTE_PENDING = '[data-route-pending]';

export async function readPendingRoutes(page: Page): Promise<PendingRoute[]> {
  return page.$$eval('[data-route-pending]', (nodes) =>
    nodes.map((node) => ({
      chunk: node.getAttribute('data-route-pending') ?? '(unnamed)',
      // Absent on a build that predates SC-840 rather than defaulted to a
      // phase, because `unknown` is a true statement and `loading` would be a
      // guess printed as a measurement.
      phase: node.getAttribute('data-route-pending-phase') ?? 'unknown',
      failures: Number(node.getAttribute('data-route-pending-failures') ?? '-1'),
    }))
  );
}

export interface SpinnerEvidence {
  screen: string;
  /** Document loads since `goto`, and when. `1` is the navigation itself. */
  loads: { count: number; at: number[] };
  pending: PendingRoute[];
  /** Whether the v3 shell was still on the page. */
  shellPresent: boolean;
  /** Where in the test this was observed, e.g. `when the capture finished`. */
  where: string;
}

/** The two causes, kept as words so a caller can assert on the verdict rather
 *  than on prose that will be reworded. */
export type SpinnerCause = 'reload' | 'route-pending' | 'shell-gone';

/**
 * Which cause the evidence supports — derived, never assumed.
 *
 * A document load beyond the navigation is A's signature and nothing else
 * produces it, so it decides. Below that threshold A is **excluded**, not
 * merely unobserved: the reloaded document would have fired `load`.
 */
export function classifySpinner(evidence: SpinnerEvidence): SpinnerCause {
  if (evidence.loads.count > 1) return 'reload';
  if (evidence.pending.length > 0) return 'route-pending';
  return 'shell-gone';
}

function describePending(pending: PendingRoute[]): string {
  return pending
    .map(({ chunk, phase, failures }) => {
      if (phase === 'unknown') {
        return `"${chunk}" (this build predates SC-840, so what the fetch was doing is unrecorded)`;
      }
      if (failures > 0) {
        return (
          `"${chunk}" — ${phase}, and ${failures} fetch(es) of it had ALREADY FAILED. ` +
          'This chunk was not slow, it was erroring; waiting longer would not have helped'
        );
      }
      return `"${chunk}" — ${phase}, first request, nothing had failed yet`;
    })
    .join('; ');
}

/**
 * The sentence, with the evidence that chose it.
 *
 * Every branch prints the load count, including — especially — the one where
 * the count is what rules the other cause out. A reader who is told "this is
 * not the reload" and not told why has been given the same assertion the old
 * message gave, pointing the other way.
 */
export function describeSpinner(evidence: SpinnerEvidence): string {
  const { screen, loads, pending, where } = evidence;
  const cause = classifySpinner(evidence);
  const loadsPhrase =
    loads.count === 0
      ? 'the document never fired `load`'
      : `${loads.count} document load(s) at ${loads.at.join('ms, ')}ms after goto`;

  if (cause === 'reload') {
    return (
      `${screen}: RELOAD (cause A, SC-499). The SPA reloaded under the capture — ${loadsPhrase}. ` +
      'Whatever this run photographed, it is not the screen it waited for, so neither a pass ' +
      "nor a pixel diff means anything. Something wrote to a file in the app's Vite module " +
      'graph while the run was in flight: do not lint, rebase, check out or save under ' +
      'apps/frontend/app or packages/frontend/ui while the gate is running.'
    );
  }

  if (cause === 'shell-gone') {
    return (
      `${screen}: the v3 shell was gone ${where} — the app unmounted mid-capture. ` +
      `${loadsPhrase}, and no route chunk is pending, so this is neither cause A nor cause B. ` +
      'A picture of a blank page is still a picture.'
    );
  }

  return (
    `${screen}: ROUTE-PENDING (cause B, SC-840). A route chunk was pending ${where}, so the ` +
    "picture is the shell's spinner rather than the screen — " +
    `${describePending(pending)}. ` +
    `THIS IS NOT THE SC-499 RELOAD: ${loadsPhrase}, and the reload works by replacing the ` +
    'document, which always fires `load`. Do not go looking for a module-graph write; there ' +
    "was none. Cause B's mechanism is not established — SC-840 carries what is known and what " +
    'is not, and this sentence is the only artefact the run leaves (trace, video and screenshot ' +
    'are all off in playwright.visual.config.ts), so please put it on the ticket.'
  );
}
