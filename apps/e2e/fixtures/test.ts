import { test as base, type TestInfo } from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * Distinguishes one `playwright test` invocation from the next.
 *
 * `testInfo.testId` is a hash of the spec path and title, so it is identical
 * across invocations — and the signup limiter's window is an hour. Without this
 * the second run of the suite inside an hour inherits the first run's spent
 * budgets, which is invisible in CI (one run per checkout) and the first thing
 * you hit trying to measure a pass rate by running it repeatedly (SC-489).
 */
const RUN_TAG = `${Date.now().toString(36)}${process.pid.toString(36)}`;

/**
 * The identity the api's inbound rate limiters bucket this test's requests
 * under.
 *
 * `defaultInflowKey` in `@scani/rate-limiter` reads the client IP from edge
 * headers and, finding none, falls back to `user-agent|origin|method`. Nothing
 * sits in front of the compose stack, so every test in a Playwright project
 * hashed to the *same* string and shared one 300-request/minute bucket — while
 * `waitForJob` polls four times a second and `workers: 4` runs four tests at
 * once. 960 polls a minute against a 300/minute budget is not a flake, it is
 * arithmetic; which test saw the 429 depended only on what its siblings had
 * already spent, so the failing set differed every run (SC-489).
 *
 * The identity rides on the User-Agent rather than on a header of its own. A
 * custom request header would be the obvious move and it is the wrong one: the
 * SPA's calls to the api are cross-origin, so an extra header turns every one
 * of them into a preflight the api's `allowedHeaders` does not permit, and the
 * app stops being able to fetch its own session. The User-Agent is sent by the
 * browser on every request, in-page fetch and `page.request` alike, and is
 * never preflighted.
 *
 * Note this makes the limiters *isolated*, not lenient: every cap is enforced
 * exactly as configured, on the same key function production uses, and
 * `tests/auth/auth-rate-limit.spec.ts` asserts one of them fires.
 *
 * `retry` is in the identity because a retry that inherits a spent bucket
 * re-runs against the state that failed it.
 */
export function rateLimitIdentity(testInfo: TestInfo, scope = 'ctx'): string {
  return `${RUN_TAG}-${scope}-${testInfo.testId}-${testInfo.retry}`;
}

/**
 * The project's User-Agent with this test's identity appended as a product
 * token. Appended rather than replaced so anything sniffing the UA — device
 * detection, the PWA shell — still sees exactly what the device descriptor
 * says it should.
 */
export function isolatedUserAgent(testInfo: TestInfo, scope?: string): string {
  const base = testInfo.project.use.userAgent;
  const token = `scani-e2e/${rateLimitIdentity(testInfo, scope)}`;
  return base ? `${base} ${token}` : token;
}

/**
 * Context options carrying an identity, for the specs that build a
 * `browser.newContext()` by hand — the `context` fixture's options do not reach
 * a context the test constructed itself.
 */
export function isolatedContextOptions(testInfo: TestInfo, scope?: string): { userAgent: string } {
  return { userAgent: isolatedUserAgent(testInfo, scope) };
}

/**
 * The suite's `test`. Specs import it from here rather than from
 * `@playwright/test` so that every request they make is bucketed under an
 * identity no other test shares; `tests/lib/rate-limit-isolation.spec.ts` fails
 * the run if one goes back to the bare import.
 */
export const test = base.extend({
  userAgent: async ({ userAgent: _base }, use, testInfo) => {
    await use(isolatedUserAgent(testInfo));
  },
});
