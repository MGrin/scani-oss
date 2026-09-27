#!/usr/bin/env bun
/**
 * Does the SPA at this URL actually mount? (SC-467 / SC-509)
 *
 *   bun apps/e2e/scripts/check-spa-boots.ts http://localhost:8080
 *
 * Exit 0 if React mounted, 1 if it did not — with the page errors printed —
 * and 3 if the check COULD NOT LOOK (SC-1309), which is not a finding about
 * the bundle at all.
 *
 * ## Why a whole script for one assertion
 *
 * `scani/frontend-app:0.13.0` — the image `scripts/self-host.sh` pulls by
 * default — rendered **nothing**. `#root` stayed empty. The cause was a
 * module-scope `throw` in the boot chain: the image is built with
 * `VITE_API_URL=/api` so one artefact serves any hostname, and both
 * `createAuthClient` and `assertFrontendEnv` required an absolute URL, so
 * `main.tsx` never ran.
 *
 * Every gate this repo has passed over it. `bun run test` does not build the
 * bundle. `docs:check` does not build the bundle. The visual gate builds a DEV
 * bundle with an absolute `VITE_API_URL`, which is the exact configuration
 * that hid the bug. **The only thing that could see it was loading the real
 * artefact in a real browser**, which is what this does.
 *
 * A module-scope throw is the worst shape the failure could take: there is no
 * error boundary above module scope, so there is nothing to render an error;
 * no network request is made, so there is nothing in a HAR; and an empty page
 * is indistinguishable from a slow one. `#root` having children is the only
 * signal, and it is a binary one.
 *
 * So the assertion is deliberately shallow — this is not an e2e test of the
 * app, it is a smoke test of the artefact. It asks one question, and it asks
 * it of the thing that ships.
 *
 * ## Exit 1 is only ever a claim about the bundle (SC-1309)
 *
 * With Playwright's browser missing, `chromium.launch()` threw at top level,
 * bun exited 1, and the publish script said "the frontend-app image renders
 * nothing" over an image that had built correctly — sending the reader after a
 * broken bundle that did not exist. A server that never answered took the same
 * path through `goto`'s catch. Both are the instrument failing to look, so
 * both are exit 3 now, and 1 is reserved for a page that loaded and stayed
 * empty.
 */

import { chromium } from '@playwright/test';

const COULD_NOT_CHECK = 3;
const INSTALL = 'bunx playwright install chromium-headless-shell';

const url = process.argv[2];
if (!url) {
  console.error('usage: bun apps/e2e/scripts/check-spa-boots.ts <url>');
  process.exit(2);
}

// Not configurable. A generous fixed ceiling is the whole budget: the failure
// this catches is a bundle that never mounts at all, not one that mounts
// slowly, so a knob here would only ever be turned up until the check stopped
// failing.
const TIMEOUT_MS = 20_000;

function couldNotCheck(why: string, remedy?: string): never {
  console.error(`\n? COULD NOT CHECK the SPA at ${url} — ${why}`);
  console.error('  The bundle was NOT assessed: this says nothing about whether it renders.');
  if (remedy) console.error(`  Remedy: ${remedy}`);
  process.exit(COULD_NOT_CHECK);
}

// Asked before the browser, so a container that never came up is named as
// that rather than surfacing as a navigation error inside the page check.
const reply = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(
  (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
);
if (reply instanceof Error) couldNotCheck(`nothing answered: ${reply.message}`);
if (!reply.ok) couldNotCheck(`the server answered HTTP ${reply.status}, not the page`);

const browser = await chromium
  // The same two flags every Playwright config here carries: a host launch
  // must never reach the operator's keychain (keychain-free-launch.test.ts).
  .launch({ args: ['--password-store=basic', '--use-mock-keychain'] })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const missing = /Executable doesn't exist|playwright install/i.test(message);
    return couldNotCheck(
      `the browser ${missing ? 'is not installed' : 'failed to launch'}: ${message.split('\n')[0]}`,
      missing ? INSTALL : undefined
    );
  });
const page = await browser.newPage();

const pageErrors: string[] = [];
const consoleErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

let navigationError: string | null = null;
let mounted = false;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  try {
    // Children of #root, not text: a shell that mounts and then shows an empty
    // state is a working artefact, and asserting on copy would make this fail
    // for reasons that have nothing to do with booting.
    await page.waitForFunction(
      () => (document.getElementById('root')?.childElementCount ?? 0) > 0,
      undefined,
      { timeout: TIMEOUT_MS }
    );
    mounted = true;
  } catch {
    mounted = false;
  }
} catch (error) {
  navigationError = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
}

await browser.close();

if (navigationError !== null) couldNotCheck(`the page never loaded: ${navigationError}`);

if (mounted) {
  console.log(`✓ the SPA at ${url} mounted`);
  // Errors AFTER mount are not this script's business — an API that is not
  // running will produce plenty, and the artefact is still fine.
  process.exit(0);
}

console.error(`\n✗ the SPA at ${url} rendered nothing — #root has no children.\n`);
if (pageErrors.length > 0) {
  console.error('  Uncaught errors:');
  for (const error of pageErrors) console.error(`    ${error}`);
}
if (consoleErrors.length > 0) {
  console.error('  console.error:');
  for (const error of consoleErrors.slice(0, 10)) console.error(`    ${error}`);
}
if (pageErrors.length === 0 && consoleErrors.length === 0) {
  console.error('  Nothing was logged. That is itself the signature of a module-scope throw');
  console.error('  in a bundle whose sourcemap did not load — check the browser by hand.');
}
process.exit(1);
