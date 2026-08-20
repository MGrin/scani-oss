import { expect, test } from '@playwright/test';
import { VISUAL_SESSION_FILE } from '../fixtures/visual-setup';
import { VISUAL_SCREENS } from './screens';

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

test.use({ storageState: VISUAL_SESSION_FILE });

/** The v3 shell's root. Present on every routed screen; absent means the app
 *  never mounted, which is the failure a screenshot hides best — a picture of
 *  a blank page is still a picture. */
const SHELL = '[data-ui="v3"]';

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

for (const screen of VISUAL_SCREENS) {
  test(`${screen.name} @${screen.viewport}`, async ({ page }, testInfo) => {
    if (screen.height) {
      const width = testInfo.project.use.viewport?.width;
      if (!width) throw new Error(`project "${testInfo.project.name}" declares no viewport width`);
      await page.setViewportSize({ width, height: screen.height });
    }
    await page.clock.setFixedTime(FIXED_NOW);

    await page.goto(screen.route);
    await page.waitForSelector(SHELL, { timeout: SHELL_TIMEOUT_MS });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);

    await expect(page).toHaveScreenshot(`${screen.name}.png`);
  });
}
