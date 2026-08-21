import { expect, type Page, test } from '@playwright/test';
import { VISUAL_EMPTY_SESSION_FILE, VISUAL_SESSION_FILE } from '../fixtures/visual-setup';
import { VISUAL_SCREENS, type VisualScreen, type VisualSession } from './screens';

/**
 * The visual-regression gate (SC-24). One test per screen in `screens.ts`,
 * each asserting the rendered pixels against a committed baseline.
 *
 * **Baselines are migrations.** They are generated once, on one branch, and
 * reviewed as the image diff in that branch's PR. A red run here is a
 * question — "is this change intended?" — and `--update` is the answer to it
 * only after somebody has looked at the diff. Regenerating the set wholesale
 * to make a build green deletes the only record of what changed.
 *
 * Each test carries its viewport as a tag, and the two projects in
 * `playwright.visual.config.ts` select on it. A screen therefore runs once,
 * at the size it was written for, rather than twice with one half skipped.
 */

/** The storage state each `session` is photographed under — see
 *  `fixtures/visual-setup.ts`, which writes both. */
const SESSION_FILE: Record<VisualSession, string> = {
  seeded: VISUAL_SESSION_FILE,
  empty: VISUAL_EMPTY_SESSION_FILE,
};

/** The v3 shell's root. Present on every routed screen; absent means the app
 *  never mounted, which is the failure a screenshot hides best — a picture of
 *  a blank page is still a picture. */
const SHELL = '[data-ui="v3"]';

/**
 * The route chunk's Suspense fallback, and the reason the shell alone is not a
 * readiness check (SC-473).
 *
 * v3 splits its routes and deliberately does **not** split the shell, so
 * `SHELL` is on screen from the first paint whether or not the screen under it
 * has downloaded. Home lost that race where the other four screens won it, and
 * the first `home-phone` baseline generated from this file was a picture of a
 * centred spinner — which the gate would then have asserted forever, going
 * green on a screen it had never seen. `lazy-route.tsx` marks the fallback for
 * this wait; `detached` also passes instantly when the chunk was already
 * cached and the fallback never mounted.
 */
const ROUTE_PENDING = '[data-route-pending]';

/** How long a screen gets to put the shell on screen. Generous because the
 *  first navigation of a run also compiles the v3 module graph: the stack
 *  serves the SPA from a Vite dev server, which does that on demand. */
const SHELL_TIMEOUT_MS = 90_000;

/**
 * After the shell is up and the network is quiet. The loading ramp (V3-16)
 * holds a skeleton through its first beat, and a skeleton is a picture of
 * nothing.
 */
const SETTLE_MS = 800;

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
const FIXED_NOW = new Date('2027-03-04T09:15:00Z');

/**
 * Waits until the screen is on the page **and stays there**.
 *
 * The second half is the part that was missing. The SPA reloads itself for
 * reasons that have nothing to do with the screen under test — a service
 * worker taking over, the dev server re-optimising a dependency — and a
 * reload puts it back behind a lazy fallback with only the eagerly-loaded
 * install prompt drawn. Waiting once and then capturing photographs whatever
 * the page happens to be at that instant, which on a bad run is a centred
 * spinner: `toHaveScreenshot` then retries, sees the same spinner twice,
 * reports "captured a stable screenshot" and fails on a picture of nothing.
 *
 * Measured before this existed, on baselines that had passed forty minutes
 * earlier: 2 of 8 screens failed that way in one run, and one of the two was
 * `holdings-phone` — a committed baseline, unrelated to the change being
 * made. So this is not a home-screen problem and never was; home is only
 * where it was finally looked at (SC-473).
 *
 * Re-checking after the settle window cannot make a reload impossible — one
 * can still land inside `toHaveScreenshot` itself — but it moves the odds
 * from "whatever the page was doing" to "it was rendered and still rendered
 * `SETTLE_MS` later", and it fails with a sentence rather than a baseline.
 */
async function settle(page: Page): Promise<void> {
  const deadline = Date.now() + SHELL_TIMEOUT_MS;
  for (let attempt = 1; ; attempt++) {
    await page.waitForSelector(SHELL, { timeout: SHELL_TIMEOUT_MS });
    await page.waitForSelector(ROUTE_PENDING, { state: 'detached', timeout: SHELL_TIMEOUT_MS });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);

    const stillThere =
      (await page.locator(SHELL).count()) > 0 && (await page.locator(ROUTE_PENDING).count()) === 0;
    if (stillThere) return;
    if (Date.now() > deadline) {
      throw new Error(
        `the screen kept unmounting: ${attempt} attempts, and after each settle the shell was ` +
          'gone or the route was pending again. Something is reloading the SPA under the run.'
      );
    }
  }
}

function declare(screen: VisualScreen): void {
  test(`${screen.name} @${screen.viewport}`, async ({ page }, testInfo) => {
    if (screen.height) {
      const width = testInfo.project.use.viewport?.width;
      if (!width) throw new Error(`project "${testInfo.project.name}" declares no viewport width`);
      await page.setViewportSize({ width, height: screen.height });
    }
    await page.clock.setFixedTime(FIXED_NOW);

    await page.goto(screen.route);
    await settle(page);

    await expect(page).toHaveScreenshot(`${screen.name}.png`);
  });
}

/**
 * Grouped by session, because `storageState` is fixture configuration and
 * `test.use` is the only way to set it — it cannot be chosen inside a test
 * body. A screen therefore names the account it wants (SC-473) and lands in
 * the group that signs that account in.
 */
for (const session of Object.keys(SESSION_FILE) as VisualSession[]) {
  const screens = VISUAL_SCREENS.filter((screen) => (screen.session ?? 'seeded') === session);
  if (screens.length === 0) continue;
  test.describe(session, () => {
    test.use({ storageState: SESSION_FILE[session] });
    for (const screen of screens) declare(screen);
  });
}
