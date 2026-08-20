import type { BrowserContext, Page } from '@playwright/test';
import {
  type A11yFinding,
  formatFindings,
  measureSmallInputs,
  measureUndersizedTargets,
  scanSurface,
} from '../../fixtures/a11y';
import { signIn } from '../../fixtures/auth';
import { type ViewportName, viewportDescriptor } from '../../fixtures/devices';
import { expect, isolatedContextOptions, test } from '../../fixtures/test';
import { createAccount, createHolding } from '../../fixtures/ui';
import { V3_A11Y_ROUTES } from '../../fixtures/v3-routes';

/**
 * The §2.6 accessibility gate for v3 (V3-17).
 *
 * Two tests, and both of them walk every surface before asserting anything.
 * That shape is deliberate: a gate that stops at the first offending route
 * takes as many runs to clear as there are problems, and each run here costs
 * a stack boot. So each check accumulates, and one failure prints the whole
 * list.
 *
 * The three §2.6 checks share a single walk for the same reason — three
 * passes over seventeen routes is three times the wall clock for information
 * one pass already has.
 *
 * One signed-in context serves the file rather than the per-test `page`
 * fixture, because signing in twice would pay the OTP round-trip twice for a
 * walk that is already the longest thing in the suite. `mode: serial` follows
 * from that shared state. (It used to be about the 6-per-IP-per-hour sign-in
 * cap; each sign-in has carried a client identity of its own since SC-489.)
 */
test.describe.configure({ mode: 'serial' });

/** Below this the shell is a tab bar plus a drawer; above it, a sidebar. Same
 *  number as the `lg:` variant `V3Shell` switches on. */
const DESKTOP_WIDTH = 1024;

const SETTLE_MS = 600;

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';

/** Generous on purpose: the budget is per *walk*, not per route, and a CI
 *  runner under four workers is several times slower than a laptop. */
const WALK_TIMEOUT_MS = 10 * 60_000;

/** How long a route gets to put the v3 shell on screen. */
const SHELL_TIMEOUT_MS = 45_000;

/**
 * And how long the *first* one gets. The stack serves the SPA from a Vite dev
 * server, which compiles the module graph on demand — so the first navigation
 * into `/` pays for the whole v3 tree at once, and on a CI runner already
 * running four browser workers that is well past the per-route budget. Every
 * route after it is served from Vite's cache.
 */
const WARMUP_TIMEOUT_MS = 120_000;

let context: BrowserContext;
let page: Page;
let isPhone = false;

async function seed(target: Page): Promise<void> {
  // Deliberately small and fiat-only, same reasoning as the screenshot
  // harness: these tokens ship in migration 0000 rather than arriving from a
  // CoinGecko sync a CI stack has never run. Two accounts so the grouped
  // views have something to group.
  const specs = [
    { account: 'A11y Checking', type: 'Checking Account', symbol: 'USD', quantity: '12500' },
    { account: 'A11y Brokerage', type: 'Investment Account', symbol: 'EUR', quantity: '8200' },
  ];
  for (const spec of specs) {
    const account = await createAccount(target, { name: spec.account, type: spec.type });
    try {
      await createHolding(target, {
        accountId: account.id,
        symbol: spec.symbol,
        quantity: spec.quantity,
        // Each new user also kicks off the portfolio-rollup chain, so the
        // holding job queues behind it. 30s is enough on an idle worker and
        // not on this one — and a timeout here means every list renders its
        // empty state and the gate passes without having scanned a row.
        jobTimeoutMs: 120_000,
      });
    } catch (err) {
      // A holding is created by a worker job that also prices it; a stack
      // without upstream access fails the pricing half. An empty state is a
      // surface worth scanning too, so a partial seed beats aborting.
      console.warn(`  ! ${spec.account}/${spec.symbol} not seeded: ${(err as Error).message}`);
    }
  }
}

async function visit(route: string, shellTimeoutMs = SHELL_TIMEOUT_MS): Promise<void> {
  await page.goto(route);
  await page.waitForSelector('[data-ui="v3"]', { timeout: shellTimeoutMs });
  // The loading ramp (V3-16) holds a skeleton through its first beat, and a
  // skeleton has neither text to contrast nor a target to size. Letting the
  // network go quiet is what makes the scan land on the real screen.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

test.beforeAll(async ({ browser }, testInfo) => {
  // Two seed jobs at up to 120s each, then the Vite warm-up at up to 120s.
  // Seeding waits on BullMQ jobs that also price their token, behind whichever
  // scheduled jobs the worker picked up first — comfortably past the 30s a
  // hook gets by default, and past the per-job budget in the worst case, which
  // is why that one warns rather than failing.
  testInfo.setTimeout(480_000);
  const descriptor = viewportDescriptor(testInfo.project.name as ViewportName);
  isPhone = (descriptor.viewport?.width ?? DESKTOP_WIDTH) < DESKTOP_WIDTH;
  // The context is built by hand rather than taken from the `page` fixture so
  // one sign-in serves the whole file (see the note above), which means the
  // device descriptor and the base URL have to be reapplied here. Same env
  // var and default as `playwright.config.ts`.
  // `isolatedContextOptions` gives this file a rate-limit identity of its own:
  // the walk is seventeen routes of API traffic and the `context` fixture's
  // options do not reach a context the test built itself, so without it every
  // request here lands in the identity every other spec shares (SC-489). It
  // must come after `...descriptor`, which carries the device's own
  // User-Agent — the identity is appended to that.
  context = await browser.newContext({
    ...descriptor,
    baseURL: BASE_URL,
    ...isolatedContextOptions(testInfo, 'a11y'),
  });
  page = await context.newPage();
  await signIn({ page, label: `a11y-${testInfo.project.name}` });
  await seed(page);
  // Pay the Vite compile once, here, where the budget is explicit — rather
  // than inside the walk, where it lands on whichever route happens to be
  // first and reads as that route failing to render.
  await visit('/', WARMUP_TIMEOUT_MS);
});

test.afterAll(async () => {
  await context?.close();
});

test('every v3 route meets the §2.6 accessibility floor', async () => {
  // Seventeen routes, each waiting for its data and then handing the tree to
  // axe. `test.slow()` triples the 30s default, which is not close.
  test.setTimeout(WALK_TIMEOUT_MS);

  const findings: A11yFinding[] = [];
  const problems: string[] = [];
  let targetsScanned = 0;
  let inputsScanned = 0;

  for (const route of V3_A11Y_ROUTES) {
    await visit(route);
    findings.push(...(await scanSurface(page, route)));

    // §2.6 row 7. Checked on every viewport: a 14px input is 14px on a
    // desktop too, and the type scale has no role at that size.
    const inputs = await measureSmallInputs(page, route);
    inputsScanned += inputs.scanned;
    for (const input of inputs.offenders) {
      problems.push(`${route} — ${input.selector} at ${input.fontSize}px, under the 16px floor`);
    }

    // §2.6 row 1, and only where the rule applies: the v3 token layer spends
    // `--tap-target` behind `pointer: coarse`, because a mouse resolves a
    // 32px target and desktop density is the point of that scoping.
    if (!isPhone) continue;
    const targets = await measureUndersizedTargets(page, route);
    targetsScanned += targets.scanned;
    for (const target of targets.offenders) {
      problems.push(`${route} — ${target.selector} is ${target.width}×${target.height}, under 44`);
    }
  }

  if (findings.length > 0) problems.push(formatFindings(findings));
  expect(problems, `§2.6 violations:\n${problems.join('\n')}`).toEqual([]);

  // The two measurements above report offenders, and "no offenders" is also
  // what a walk that rendered nothing returns — a failed seed, a skeleton that
  // never resolved, a shell that did not mount. These floors are what make the
  // pass mean something. Deliberately far below the real counts (a phone walk
  // measures hundreds of controls); they are a liveness check, not a budget.
  expect(
    inputsScanned,
    'no text-entry control was measured — did the walk render?'
  ).toBeGreaterThan(0);
  if (isPhone) {
    expect(targetsScanned, 'no touch target was measured — did the shell mount?').toBeGreaterThan(
      V3_A11Y_ROUTES.length
    );
  }
});

test('v3 overlays meet the §2.6 accessibility floor', async () => {
  test.setTimeout(WALK_TIMEOUT_MS);
  const findings: A11yFinding[] = [];

  // The surfaces that are not routes. Each opens over the screen the user is
  // reading, which is exactly why a route walk never sees them — and exactly
  // why they are the ones most likely to be missing a dialog name or a
  // reachable close.
  await visit('/holdings');

  if (isPhone) {
    await page.getByRole('button', { name: /^more/i }).click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    findings.push(...(await scanSurface(page, 'more-drawer')));
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }

  await page.getByRole('button', { name: isPhone ? /^add$/i : /^add data$/i }).click();
  await expect(page.getByRole('dialog').first()).toBeVisible();
  findings.push(...(await scanSurface(page, 'capture-sheet')));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(findings, `axe violations:\n${formatFindings(findings)}`).toEqual([]);
});
