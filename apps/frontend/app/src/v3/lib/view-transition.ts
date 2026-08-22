import { resolveActiveV3Path } from './routes';

/**
 * Route transitions on the View Transitions API — §2.4's "zero bundle" line.
 *
 * Baseline Newly Available since October 2025 (Chrome/Edge 111+, Firefox 133+,
 * Safari 18+), so for a PWA on a modern phone this is full coverage and costs
 * nothing to ship. Motion/Framer would have been ~31KB gzipped for the same
 * cross-fade. Anywhere the API is missing, the navigation simply happens — the
 * fallback is the app without the animation, never a broken route.
 *
 * Two bail-outs, and both matter:
 *
 * - **`prefers-reduced-motion`.** The CSS in `styles/v3-motion.css` already
 *   guards the pseudo-element animations, but the transition itself still
 *   freezes the page for a frame while it snapshots, so the honest answer is
 *   not to start one at all.
 * - **Same-destination navigations.** Opening a peek sheet, closing it, or
 *   moving between Money's segments all change the URL without changing the
 *   screen. Cross-fading the list under a sheet that is sliding up is two
 *   animations disagreeing about what just happened.
 */

/** The subset of `Document` this needs, so the predicate stays testable. */
export interface ViewTransitionDocument {
  startViewTransition?: (update: () => void) => unknown;
}

/**
 * Whether a navigation from `from` to `to` should be animated at all.
 *
 * The rule is the nav destination, not the pathname: `/v3/payments` and
 * `/v3/payments/abc123` are the same screen with a sheet over it, and
 * `resolveActiveV3Path` is already the single place v3 decides that.
 */
export function shouldTransitionRoute(from: string, to: string): boolean {
  if (from === to) return false;
  return resolveActiveV3Path(from) !== resolveActiveV3Path(to);
}

export function supportsViewTransitions(doc: ViewTransitionDocument | undefined): boolean {
  return typeof doc?.startViewTransition === 'function';
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Runs `update` inside a view transition when one is possible and wanted, and
 * plainly otherwise. Returns whether it took the animated path.
 *
 * `flush` is React's `flushSync`, injected rather than imported so this file
 * stays a pure function of its arguments. It is only applied on the animated
 * path, and there it is mandatory: the API snapshots the DOM the moment the
 * callback returns, so a batched update would be captured before React had
 * rendered the new screen and the transition would cross-fade the old page
 * with itself.
 */
export function runViewTransition(update: () => void, flush: (apply: () => void) => void): boolean {
  // Cast rather than augment `Document`: the API is newer than the DOM lib
  // this repo compiles against, and a global augmentation for one call site
  // is a wider claim than the one place that needs it.
  const doc =
    typeof document === 'undefined' ? undefined : (document as unknown as ViewTransitionDocument);
  const start = doc?.startViewTransition;
  if (typeof start !== 'function' || prefersReducedMotion()) {
    update();
    return false;
  }
  start.call(doc, () => flush(update));
  return true;
}
