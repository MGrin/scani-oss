import { expect, type Page, test } from '@playwright/test';
import {
  INSTITUTION_ICON_PATH,
  type PinnedNetwork,
  pinExternalNetwork,
} from '../fixtures/visual-network';
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
 * How many times the document has loaded since `goto`, and when.
 *
 * **This is the ticket's whole point** (SC-499). The SPA reloads under the run
 * and nothing in the page says so: Vite's dev client answers a `full-reload`
 * message by calling `location.reload()` with no console output at all
 * (`pageReload()` in `vite/dist/client/client.mjs`), and the reloaded document
 * is the shell's install prompt and a centred spinner. `toHaveScreenshot` then
 * retries, gets the same spinner twice, logs "captured a stable screenshot"
 * and reports a pixel count — **a stable wrong answer reads exactly like a
 * stable right one**, which is how a spinner became a committed baseline
 * (SC-473).
 *
 * A document load is the one signal that cannot be mistaken for anything else,
 * so it is counted rather than inferred from the DOM.
 */
interface DocumentLoads {
  count: number;
  /** ms after `goto`, so a failure says *when* the page went away. */
  at: number[];
}

function trackDocumentLoads(page: Page): DocumentLoads {
  const t0 = Date.now();
  const loads: DocumentLoads = { count: 0, at: [] };
  page.on('load', () => {
    loads.count += 1;
    loads.at.push(Date.now() - t0);
  });
  return loads;
}

/**
 * Waits until the screen is on the page **and stays there**.
 *
 * The second half is the part that was missing. The SPA reloads itself for
 * reasons that have nothing to do with the screen under test, and a reload
 * puts it back behind a lazy fallback with only the eagerly-loaded install
 * prompt drawn. Waiting once and then capturing photographs whatever the page
 * happens to be at that instant, which on a bad run is a centred spinner.
 *
 * Measured before this existed, on baselines that had passed forty minutes
 * earlier: 2 of 8 screens failed that way in one run, and one of the two was
 * `holdings-phone` — a committed baseline, unrelated to the change being
 * made. So this is not a home-screen problem and never was; home is only
 * where it was finally looked at (SC-473).
 *
 * **What is reloading it, established rather than guessed (SC-499).** Vite's
 * HMR client, on a `full-reload` message from the dev server, which the server
 * broadcasts to every open page when any file in the app's module graph
 * changes on disk. The gate runs against `vite` in the `frontend` container
 * with the repo bind-mounted, so a `bun lint:fix`, a `git checkout`, a rebase
 * or an editor save anywhere under `apps/frontend/app` or `packages/frontend/ui`
 * — while a run is in flight — reloads every screen mid-capture. Reproduced
 * on demand: appending one comment line to `src/main.tsx` every three seconds
 * during a run took `kitchen-sink-desktop` through **ten** document loads and
 * produced exactly the reported failure, a picture of a spinner reported as
 * "2260538 pixels are different".
 *
 * The two candidates the ticket carried are both ruled out. The service worker
 * cannot be it: `main.tsx` registers it under `import.meta.env.PROD` and this
 * gate runs the dev server, so no worker is ever installed — and the reload it
 * would trigger is guarded by `wasDocumentControlledAtLoad()` anyway (SC-130).
 * Nor is it Vite's dependency optimiser: wiping `node_modules/.vite` and
 * restarting the dev server still gave 8/8 with exactly one document load per
 * screen and no re-optimisation in the server log.
 *
 * Re-checking after the settle window cannot make a reload impossible — one
 * can still land inside `toHaveScreenshot` itself, which is what the
 * post-capture assertion in `declare` is for — but it moves the odds from
 * "whatever the page was doing" to "it was rendered and still rendered
 * `SETTLE_MS` later", and it fails with a sentence rather than a baseline.
 */
async function settle(page: Page, loads: DocumentLoads): Promise<void> {
  const deadline = Date.now() + SHELL_TIMEOUT_MS;
  for (let attempt = 1; ; attempt++) {
    const before = loads.count;
    await page.waitForSelector(SHELL, { timeout: SHELL_TIMEOUT_MS });
    await page.waitForSelector(ROUTE_PENDING, { state: 'detached', timeout: SHELL_TIMEOUT_MS });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);

    const stillThere =
      loads.count === before &&
      (await page.locator(SHELL).count()) > 0 &&
      (await page.locator(ROUTE_PENDING).count()) === 0;
    if (stillThere) return;
    if (Date.now() > deadline) {
      throw new Error(
        `the screen kept unmounting: ${attempt} attempts, and after each settle the shell was ` +
          `gone or the route was pending again (${loads.count} document loads at ` +
          `${loads.at.join('ms, ')}ms). Something is reloading the SPA under the run — see the ` +
          'note on this function.'
      );
    }
  }
}

/**
 * What the picture has to be a picture of, checked after it was taken.
 *
 * `settle` runs *before* `toHaveScreenshot`, and a reload landing inside the
 * capture is outside anything it can see. This is that gap, and closing it is
 * what makes this gate honest: **a screen is photographed exactly once per
 * document load**. More than one load between `goto` and here means the page
 * this run photographed is not the page it waited for, whatever the pixels
 * came out as.
 *
 * Deliberately checked on a *passing* capture too, and that is the important
 * half. A reload during `--update` writes the spinner into the baseline and
 * every run afterwards agrees with it — green, forever, on a screen nobody has
 * ever seen. That is not a hypothetical: it is SC-473, and this assertion is
 * the only thing between the harness and doing it again.
 */
type Fail = (message: string) => never;

/**
 * How a post-capture check reports, given what the capture did.
 *
 * @param captured the capture's own failure, kept as the `cause` so its pixel
 *   count is still in the report — it is a true statement about the wrong page.
 * @param wroteBaseline under `--update`, `toHaveScreenshot` has already written
 *   the PNG by the time these checks run. Nothing here can un-write it, so the
 *   message has to say so — a red run whose baseline is silently now a spinner
 *   is the SC-473 failure with an extra step.
 */
function failWith(name: string, captured: unknown, wroteBaseline: boolean): Fail {
  return (message: string): never => {
    throw new Error(
      wroteBaseline
        ? `${message}\n\n--update has ALREADY overwritten visual/__screenshots__/${name}.png ` +
            'with this capture. `git checkout` it before doing anything else.'
        : message,
      { cause: captured }
    );
  };
}

/**
 * That the picture was drawn from bytes this repository controls (SC-524).
 *
 * Two halves, and the second is the one a future reader will want to delete.
 *
 * **Nothing escaped.** `pinExternalNetwork` aborts every off-host request it
 * was not told to serve, so an `escaped` entry is a byte source the gate
 * cannot reproduce — a diff that will appear one day for a reason nobody can
 * attribute. Reported as the URL rather than as a pixel count, because the
 * pixel count is what made SC-524 take a session to diagnose.
 *
 * **The pinned bytes actually reached the DOM.** A screen that declares
 * `institutionMark` must show at least one `<img>` at the pinned URL, decoded.
 * This looks redundant — the run just fulfilled those requests, and the
 * screenshot passed — and it is exactly what a stub that fulfils with an empty
 * body, a 404 or a zero-byte PNG would still let through: `FaviconImg` catches
 * the `onerror`, swaps in its letter tile, and the gate goes green having
 * deleted the thing it was asked to hold still. `--update` would then write
 * that letter tile into the baseline and every run afterwards would agree with
 * it. The check that a fix did not quietly remove its own subject is not
 * redundant with the fix.
 */
async function assertPinnedBytes(
  page: Page,
  network: PinnedNetwork,
  screen: VisualScreen,
  fail: Fail
): Promise<void> {
  if (network.escaped.length > 0) {
    fail(
      `${screen.name}: ${network.escaped.length} request(s) left this machine and were blocked: ` +
        `${network.escaped.join(', ')}. A baseline drawn from bytes we do not serve is not a ` +
        'baseline — see fixtures/visual-network.ts, which either pins the asset or is why this ' +
        'is red.'
    );
  }
  if (!screen.institutionMark) return;

  // The prefix is passed in rather than written out here: it is the same
  // constant the route predicate matches on, so the two cannot drift into a
  // state where the gate pins one URL and then looks for another (SC-208).
  const marks = await page.evaluate(
    (path) =>
      [...document.images].filter((img) => img.src.includes(path)).map((img) => img.naturalWidth),
    INSTITUTION_ICON_PATH
  );
  if (marks.length === 0) {
    fail(
      `${screen.name}: declares institutionMark and drew none — no <img> at the pinned URL is ` +
        `in the DOM (${network.icons} pinned request(s) were served). Either the mark fell back ` +
        "to FaviconImg's letter tile, or this screen no longer shows one and the declaration " +
        'in screens.ts is stale. Both change what the baseline is a picture of.'
    );
  }
  if (marks.some((width) => width === 0)) {
    fail(
      `${screen.name}: an institution mark is in the DOM but decoded to nothing ` +
        `(naturalWidth ${marks.join(', ')}). The pinned bytes are not a readable image, so the ` +
        'row renders a gap where the baseline holds a mark.'
    );
  }
}

/**
 * Puts the document into the direction the screen declares (SC-760).
 *
 * `<html dir>` is written by `applyFormatLocale` from the chosen language, in
 * a `useMemo` keyed on `[language, region]` — so it is set once at mount and
 * not touched again while neither changes. That is what makes writing it from
 * here safe, and it is also exactly the kind of reasoning that is true until
 * somebody edits the provider. Hence `assertStillInDirection` below: the
 * assumption is checked against the page rather than trusted.
 *
 * Returns immediately for an LTR screen, so the `settle` budget is unchanged
 * for the eight baselines that predate this.
 */
async function applyDirection(page: Page, screen: VisualScreen): Promise<void> {
  if (!screen.dir) return;
  await page.evaluate((dir) => {
    document.documentElement.dir = dir;
  }, screen.dir);
  // A direction flip is a full relayout: every logical property resolves to
  // the other edge and the shell reflows. Reuse the settle budget rather than
  // inventing a second number.
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * That the picture is a picture of the direction it claims.
 *
 * This is the RTL twin of `assertPinnedBytes`, and it exists for the identical
 * reason. `dir` is set from outside the app, so anything that re-runs
 * `applyFormatLocale` — a language change, a remount, a future edit that adds
 * a dependency to that memo — puts it back to `ltr` silently. The capture then
 * succeeds, `--update` writes an LTR image to `*-rtl.png`, and every run
 * afterwards agrees with it: a green gate over a mirrored layout nobody has
 * ever photographed.
 *
 * Checked on a PASSING capture too, which is the half that matters. A red
 * announces itself; this is the failure that would not.
 */
async function assertStillInDirection(page: Page, screen: VisualScreen, fail: Fail): Promise<void> {
  const expected = screen.dir ?? 'ltr';
  const actual = await page.evaluate(() => document.documentElement.dir || 'ltr');
  if (actual !== expected) {
    fail(
      `${screen.name}: declares dir="${expected}" and the document read "${actual}" when the ` +
        'capture finished, so this picture is of the other direction. `applyFormatLocale` ' +
        'writes `<html dir>` from the chosen language; something re-ran it under the capture. ' +
        'A baseline written from here would be an LTR screen filed under an RTL name (SC-760).'
    );
  }
}

async function assertPhotographedOnce(
  page: Page,
  loads: DocumentLoads,
  name: string,
  fail: Fail
): Promise<void> {
  if (loads.count > 1) {
    fail(
      `${name}: the SPA reloaded under the capture — ${loads.count} document loads at ` +
        `${loads.at.join('ms, ')}ms after goto. Whatever this run photographed, it is not the ` +
        'screen it waited for, so neither a pass nor a pixel diff means anything. Something ' +
        "wrote to a file in the app's Vite module graph while the run was in flight (SC-499): " +
        'do not lint, rebase, check out or save under apps/frontend/app or packages/frontend/ui ' +
        'while the gate is running.'
    );
  }
  if ((await page.locator(ROUTE_PENDING).count()) > 0) {
    fail(
      `${name}: the route chunk was pending again when the capture finished, so the picture is ` +
        "the shell's spinner rather than the screen. The SPA remounted mid-capture (SC-499)."
    );
  }
  if ((await page.locator(SHELL).count()) === 0) {
    fail(
      `${name}: the v3 shell was gone when the capture finished — the app unmounted mid-capture ` +
        '(SC-499). A picture of a blank page is still a picture.'
    );
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

    // Before `goto`: a route added after a navigation has started does not
    // apply to the requests that navigation already made.
    const network = await pinExternalNetwork(page);
    const loads = trackDocumentLoads(page);
    await page.goto(screen.route);
    await settle(page, loads);
    await applyDirection(page, screen);

    // The capture's own failure is held rather than thrown, because
    // `assertPhotographedOnce` can explain it: a pixel count over a spinner is
    // a true statement about the wrong page, and reporting it as the diff is
    // how SC-473 spent a session comparing images of nothing.
    let captured: unknown;
    try {
      await expect(page).toHaveScreenshot(`${screen.name}.png`);
    } catch (error) {
      captured = error;
    }
    const fail = failWith(
      screen.name,
      captured,
      // `'missing'` is the default and only writes a baseline that is absent;
      // `'all'` and `'changed'` are what `--update` sets, and both overwrite.
      testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed'
    );
    await assertPhotographedOnce(page, loads, screen.name, fail);
    await assertStillInDirection(page, screen, fail);
    await assertPinnedBytes(page, network, screen, fail);
    if (captured) throw captured;
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
