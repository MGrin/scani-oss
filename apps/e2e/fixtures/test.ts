import { test as base, type TestInfo } from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * The identity the api's inbound rate limiters will bucket a request under.
 *
 * `defaultInflowKey` in `@scani/rate-limiter` reads the client IP from edge
 * headers and, finding none, falls back to `user-agent|origin|method`. Nothing
 * sits in front of the compose stack, so every test in a Playwright project
 * hashed to the *same* string and shared one 300-request/minute bucket — while
 * `waitForJob` polls `jobs.status` four times a second and `workers: 4` runs
 * four tests at once. 960 polls a minute against a 300/minute budget is not a
 * flake, it is arithmetic; which test saw the 429 depended only on what its
 * siblings had already spent, so the failing set differed every run (SC-489).
 *
 * `x-real-ip` is the generic-proxy header that key function already trusts, and
 * in this stack Playwright *is* the only thing in front of the api. Keying it
 * per test gives each test the whole budget to itself. Note this makes the
 * limiter *isolated*, not lenient: every cap is still enforced exactly as
 * configured, and `tests/auth/auth-rate-limit.spec.ts` asserts one of them
 * fires.
 *
 * `retry` is in the key because a retry that inherits a spent bucket re-runs
 * against the state that failed it.
 */
export function rateLimitIdentity(testInfo: TestInfo, scope = 'ctx'): string {
  return `e2e-${scope}-${testInfo.testId}-${testInfo.retry}`;
}

/**
 * Context options carrying this test's rate-limit identity, for the specs that
 * build a `browser.newContext()` by hand — the `context` fixture's options do
 * not reach a context the test constructed itself.
 */
export function isolatedContextOptions(
  testInfo: TestInfo,
  scope?: string
): { extraHTTPHeaders: Record<string, string> } {
  return { extraHTTPHeaders: { 'x-real-ip': rateLimitIdentity(testInfo, scope) } };
}

/**
 * The suite's `test`. Specs import it from here rather than from
 * `@playwright/test` so that every request they make is bucketed under an
 * identity no other test shares; `tests/lib/rate-limit-isolation.spec.ts`
 * fails the run if one goes back to the bare import.
 */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    await use({ ...extraHTTPHeaders, 'x-real-ip': rateLimitIdentity(testInfo) });
  },
});
