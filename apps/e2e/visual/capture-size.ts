import { statSync } from 'node:fs';

/**
 * That a baseline was not replaced by a picture of nothing (SC-867).
 *
 * ## The gap this closes
 *
 * `v3-screens.spec.ts` carries three defences against photographing a
 * spinner, and all three key on a CAUSE:
 *
 * | guard | keys on | ticket |
 * |---|---|---|
 * | `assertPixelsSettled` | two consecutive captures differing | SC-832 |
 * | `assertPhotographedOnce` | `loads.count > 1` | SC-499 |
 * | `assertPhotographedOnce` | a `[data-route-pending]` node | SC-499 |
 *
 * Between them they cover a reload and a route chunk that has not arrived.
 * **A loading state with neither cause passes every one of them**: a query in
 * flight, a `LoadingRamp`, a suspense fallback inside a route that already
 * resolved. The picture is a spinner, it is perfectly stable, there is exactly
 * one document load, and no `[data-route-pending]` node exists — the route is
 * fine, it is the DATA that has not arrived. Under `--update` that capture
 * becomes the baseline and every later run agrees with it.
 *
 * The hazard is defined by the SYMPTOM and the guards are defined by cause, so
 * a fourth cause-specific guard would leave the next unenumerated cause open.
 * This one reads the output instead: the check is cause-agnostic by
 * construction and does not care why the screen was blank.
 *
 * ## Why a byte count is an entropy measurement
 *
 * A PNG of a fixed canvas is its content run through DEFLATE, so its length is
 * a compressed-size proxy for how much is drawn on it — no decoder, no DOM
 * query, no second capture. A screen replaced by a centred spinner on a flat
 * background collapses by an order of magnitude on the identical canvas.
 *
 * ## Why the reference is the screen's OWN previous baseline
 *
 * A repo-wide byte floor is unimplementable here and would delete itself. The
 * twelve committed baselines span 23,744 to 624,374 bytes — a 26x spread — and
 * `home-empty-phone` at 23,744 is legitimately SMALLER than several of the
 * loading-state captures this guard exists to reject. Any constant that clears
 * the small real screens sits above the artefacts on the large ones, so
 * whoever met it would raise it until it stopped complaining and the guard
 * would end up unable to fire.
 *
 * Per screen there is no such problem, because the reference already exists:
 * the committed baseline, at the same canvas, from the same renderer. The
 * comparison needs no new constant beyond the ratio, and the ratio is measured
 * rather than chosen — see `MIN_BASELINE_RATIO`.
 *
 * ## Why it needs no `--update` check
 *
 * It keys on the baseline file SHRINKING between the start of the test and the
 * end of it, which only a write can do. On a run that is not updating, nothing
 * writes the file — a matching capture leaves it alone and a failing one
 * leaves it alone — so `before === after` and this is a no-op without being
 * told which mode it is in. A mode flag would be one more thing to get wrong
 * in the direction that silently disables the check.
 *
 * ## Why it refuses rather than asserting a diagnosis
 *
 * A byte count cannot tell a spinner from a redesign that genuinely stripped a
 * screen, and a guard that cannot be cleared by somebody who has looked at the
 * diff is a guard people route around. So it names the file and the numbers
 * and stops, and the override is per screen (see `BASELINE_SHRINK_ALLOW_ENV`).
 * The value is that the shrink becomes a decision somebody makes rather than a
 * file that changes silently.
 */

/**
 * How small a rewritten baseline may get before this refuses, as a fraction of
 * the baseline it replaced.
 *
 * **0.70 is the geometric midpoint of two measured distributions**, not a
 * chosen number. Both were taken on this repo, 2026-09-01, and both are
 * re-takeable in one command each.
 *
 * ## What the artefact measures
 *
 * Every screen captured with the SPA's tRPC responses stalled — see
 * `stallDataIfAsked` in `v3-screens.spec.ts`, which is committed so this
 * column can be re-taken. As a fraction of that screen's own baseline:
 *
 * ```
 *   holdings-desktop-rtl         35,184 /  66,467 = 52.9%   <- shallowest
 *   holdings-desktop             35,156 /  66,527 = 52.8%
 *   home-empty-phone             11,384 /  23,744 = 47.9%
 *   holdings-phone               16,107 /  35,785 = 45.0%
 *   home-desktop                 34,809 /  80,603 = 43.2%
 *   home-allocation-fold-desktop 37,290 / 105,586 = 35.3%
 *   home-phone-rtl               15,215 /  61,179 = 24.9%
 *   home-phone                   15,214 /  61,383 = 24.8%
 * ```
 *
 * ## What a legitimate update measures
 *
 * Every revision of every baseline in this repository's history — 37 blobs
 * across the twelve files, 12 of them an actual change. The smallest ratio any
 * committed update has ever produced:
 *
 * ```
 *   holdings-phone     38,302 -> 35,876   =  93.7%   <- smallest ever
 *   holdings-desktop   68,657 -> 66,527   =  96.9%
 *   payment-form-phone 65,606 -> 64,874   =  98.9%
 *   ...the other nine are between 100.0% and 106.1%
 * ```
 *
 * ```sh
 * git log --follow --format=%H -- apps/e2e/visual/__screenshots__/<name>.png
 * ```
 *
 * ## Why the midpoint
 *
 * The two distributions do not overlap and are not close: **52.9% is the
 * largest artefact and 93.7% is the smallest legitimate update, a 40.8-point
 * gap with nothing in it.** `sqrt(0.529 x 0.937) = 0.704`. Rounding to 0.70
 * leaves 17.1 points of headroom over the worst artefact and 23.7 points under
 * the tightest real update — about 5x the largest movement any legitimate
 * update here has ever made in either direction (+6.1%, -6.3%).
 *
 * A threshold fitted to either end would be the mistake SC-867 warns about one
 * level down. 55% would catch the same eight screens and sit 2 points from an
 * observation; 90% would refuse a real update that has already happened once.
 *
 * ## What 0.70 does NOT catch, and why that is the right answer
 *
 * Four of the twelve screens are unmoved by stalling their data:
 * `kitchen-sink-desktop`, `-rtl`, `-phone` (100.0%) and `payment-form-phone`
 * (100.1%). They render a static primitive gallery and an empty form, so there
 * is no query behind either — a data-pending capture of them is the same
 * picture, and there is nothing degenerate to refuse. **The floor catches
 * every screen on which this hazard exists.** A loading state that DID blank
 * one of them would collapse it far past 70% and be caught like any other.
 *
 * ## The number SC-867 carries is a different artefact — do not calibrate to it
 *
 * The ticket quotes 32,728 / 622,778 = 5.3%, and reasoning from it produces a
 * floor around 25% that misses six of the eight screens above. That figure is
 * a RELOAD spinner (SC-499): the document was replaced, so the shell is gone
 * too and the picture is a centred spinner on blank. SC-867's own case keeps
 * the shell — the route resolved and only the data is missing — and a v3
 * sidebar is a large share of a screen's compressed bytes. Hence 24.8% at
 * worst rather than 5%, and hence this floor sitting where it does.
 *
 * Falsify both columns from a booted stack:
 *
 * ```sh
 * cd apps/e2e
 * bun run visual                                    # 12 green, no refusal
 * SCANI_VISUAL_STALL_DATA=1 bun run visual --update # 8 refused by name
 * git checkout visual/__screenshots__/
 * ```
 */
export const MIN_BASELINE_RATIO = 0.7;

/**
 * Clears the refusal, for the screens NAMED in it.
 *
 * A comma-separated list of screen names, never a bare `1`. That is the whole
 * design of it: an escape hatch is a safety property only while using it means
 * asserting something you believe, and a blanket flag set while staring at a
 * red run clears all twelve screens on the strength of having looked at one.
 * Naming the screen is the smallest form of "I looked at this diff" that a
 * variable can carry.
 */
export const BASELINE_SHRINK_ALLOW_ENV = 'SCANI_ALLOW_BASELINE_SHRINK';

/** The baseline's size on disk, or `null` if there is not one yet. */
export function baselineBytes(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export interface BaselineCollapseInput {
  screen: string;
  /** Bytes before the capture, or `null` if the screen had no baseline. */
  before: number | null;
  /** Bytes after it. `null` means the file is not there, which nothing writes. */
  after: number | null;
  /** Raw `SCANI_ALLOW_BASELINE_SHRINK`. */
  allowed: string | undefined;
}

/** Whether `screen` was named in the override. */
function isAllowed(screen: string, allowed: string | undefined): boolean {
  return (allowed ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .includes(screen);
}

/**
 * The refusal this screen's numbers earn, or `null` if there is nothing to
 * say.
 *
 * Pure, and separated from the file reads above so both arms of it are
 * reachable from a unit test. A guard whose firing path has never been
 * executed is indistinguishable from one that cannot fire, which is the defect
 * class this whole file belongs to.
 *
 * Returns `null` — deliberately, rather than refusing — when:
 *
 * - **there was no baseline.** A first capture destroys no evidence, so the
 *   gap is in the harmless direction. It is also the only case where there is
 *   nothing to compare against, and inventing a constant for it is the global
 *   floor this file's docblock rejects.
 * - **the file did not shrink past the floor**, which includes every run that
 *   wrote nothing at all.
 */
export function baselineCollapse(input: BaselineCollapseInput): string | null {
  const { screen, before, after, allowed } = input;
  if (before === null || after === null) return null;

  const floor = Math.round(before * MIN_BASELINE_RATIO);
  if (after >= floor) return null;

  const percent = ((after / before) * 100).toFixed(1);
  if (isAllowed(screen, allowed)) return null;

  return (
    `${screen}: the baseline shrank from ${before.toLocaleString()} to ` +
    `${after.toLocaleString()} bytes — ${percent}% of what it replaced, under the ` +
    `${Math.round(MIN_BASELINE_RATIO * 100)}% floor (${floor.toLocaleString()} bytes). On an ` +
    'identical canvas from the same renderer, that much compressed content does not go ' +
    'missing from a screen that is still drawing itself. Measured, the shape it matches is a ' +
    'shell that rendered and a content area that never filled: the route resolved, the ' +
    'document loaded once and the page is perfectly still, so none of the three guards above ' +
    'this one — which key on a reload and on a route chunk — has anything to say about it ' +
    '(SC-867). Open the PNG before deciding anything else.\n\n' +
    'If you have looked at the image and this shrink is the change you meant, re-run with ' +
    `${BASELINE_SHRINK_ALLOW_ENV}=${screen} (name each screen; there is no blanket value).`
  );
}
