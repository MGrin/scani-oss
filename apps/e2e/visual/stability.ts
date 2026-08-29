import type { Page } from '@playwright/test';

/**
 * The probe's budget (SC-832), deliberately MATCHED to `toHaveScreenshot`'s.
 *
 * The first version of this was one second against the matcher's five, on the
 * reasoning that `settle` had already done the waiting and this only had to
 * ask whether the page was moving *now*. **That is a false-red generator.** A
 * screen whose chart finishes laying out at 2s would fail this probe and be
 * photographed perfectly well by the matcher — so the gate would go red on
 * screens it is entirely able to capture, and the first person to meet that
 * would correctly delete this.
 *
 * Matching the budget makes the guard's claim narrow and true: it refuses only
 * what `toHaveScreenshot` would ALSO have failed to stabilise, and it refuses
 * it BEFORE anything is written rather than after.
 *
 * `STABILITY_ATTEMPTS` is a belt-and-braces cap so the loop is bounded by
 * something other than the clock — a fake page whose waits are instant would
 * otherwise spin. Sized to cover the deadline at this gap.
 */
export const STABILITY_TIMEOUT_MS = 5_000;
export const STABILITY_GAP_MS = 250;
export const STABILITY_ATTEMPTS = Math.ceil(STABILITY_TIMEOUT_MS / STABILITY_GAP_MS) + 1;

/**
 * Every screen renders at this instant. A form that defaults a date field to
 * "today" writes today's date into its baseline, and that baseline is wrong
 * tomorrow — `/payments/recurring/new` did exactly that on the first
 * generation run. Pinning the clock removes the whole class rather than the
 * one instance, and costs nothing on a screen that never asks the time.
 *
 * Past the seeded data on purpose: the session this runs under was created
 * whenever the seed last ran, and a clock set before that would put the
 * screens in front of a session the client considers unissued.
 */
/**
 * That the page had stopped moving BEFORE the capture (SC-832).
 *
 * `toHaveScreenshot` polls until two consecutive captures are identical. When
 * they never are it produces `Failed to take two consecutive stable
 * screenshots.` — and under `--update` it then writes the last capture anyway
 * and returns **pass**:
 *
 *     if (updateSnapshots === 'changed' || updateSnapshots === 'all') {
 *       if (actual) return writeFiles(actual);   // the LAST capture
 *     }                                          // -> createMatcherResult(..., true)
 *
 * So a half-drawn chart becomes the baseline and the run is green. Every later
 * run is then measured against a picture of a page mid-layout, and agrees with
 * it. A false green that manufactures its own future false greens.
 *
 * ## Why this is checked BEFORE the capture and not after
 *
 * The obvious fix is a fifth post-capture assertion reading the held
 * `captured` error, the way `assertPhotographedOnce` reads it. **That cannot
 * work.** `writeFiles` returns `pass: true`, so in update mode
 * `toHaveScreenshot` does not throw at all: `captured` is `undefined`, the
 * closing `if (captured) throw captured` never fires, and the `errorMessage`
 * is consumed inside Playwright and never reaches this file. A post-capture
 * check would be a guard that cannot fire in the only mode the defect occurs
 * in — which is the same shape as the defect.
 *
 * Failing first is also strictly better than failing after: nothing has been
 * written, so there is no baseline to `git checkout` and `failWith`'s
 * overwrite warning would be untrue here. This throws on its own rather than
 * going through `fail`.
 *
 * ## What it measures, and what it does not
 *
 * The same criterion `toHaveScreenshot` uses — two consecutive identical
 * captures — with the options the config pins for it (`animations: 'disabled'`,
 * `caret: 'hide'`), so the probe sees what the capture will see. Matching
 * those matters: `page.screenshot` defaults to `animations: 'allow'`, and a
 * probe using the default would read a benign CSS transition as instability
 * and fail a screen the gate is perfectly able to photograph.
 *
 * **It is a proxy and not the same measurement.** A page can be still for this
 * probe and move inside `toHaveScreenshot` a moment later, and this cannot see
 * that — the same gap `assertPhotographedOnce` exists to cover for reloads.
 * What it removes is the case the ticket observed: a screen that is visibly
 * unsettled when the capture starts, which under `--update` is written without
 * anything asking whether it settled.
 */
export async function assertPixelsSettled(page: Page, name: string): Promise<void> {
  const shot = (): Promise<Buffer> => page.screenshot({ animations: 'disabled', caret: 'hide' });

  const deadline = Date.now() + STABILITY_TIMEOUT_MS;
  let previous = await shot();
  const sizes = [previous.byteLength];
  for (let attempt = 2; attempt <= STABILITY_ATTEMPTS; attempt++) {
    await page.waitForTimeout(STABILITY_GAP_MS);
    const current = await shot();
    sizes.push(current.byteLength);
    if (current.equals(previous)) return;
    previous = current;
    if (Date.now() > deadline) break;
  }

  throw new Error(
    `${name}: the page was still moving when the capture was about to start — ` +
      `${sizes.length} captures ${STABILITY_GAP_MS}ms apart across ${STABILITY_TIMEOUT_MS}ms and ` +
      `no two consecutive ones matched (${sizes.join(', ')} bytes). ` +
      `Photographing it now would record a frame of a ` +
      'page mid-layout; under `--update` that frame becomes the baseline and every later run ' +
      'agrees with it. Nothing has been written — no baseline needs restoring.'
  );
}
