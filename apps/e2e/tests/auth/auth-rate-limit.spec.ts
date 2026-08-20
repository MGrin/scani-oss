import { expect, test } from '../../fixtures/test';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

/**
 * The per-client cap on auth attempts, asserted rather than dodged.
 *
 * Before SC-489 the suite had no test for this limiter at all: it only ever met
 * it by accident, as a 429 that `fixtures/auth.ts` quietly retried past. That
 * is the shape a required CI job must not have — the limiter could have stopped
 * working entirely and every run would still have been green.
 *
 * It is deterministic because it owns its identity. `send-verification-otp` and
 * `sign-in` share one 6-per-hour budget per client
 * (`signupLimiter`, `apps/backend/api/src/index.ts`), this test is its own
 * client, and it signs in nowhere else — so all six admitted attempts below are
 * its own and no sibling can spend or reset them.
 */
test.describe('auth: per-client attempt cap', () => {
  test('7th auth attempt from one client within the hour is rejected', async ({
    page,
  }, testInfo) => {
    const email = `e2e-cap-${testInfo.testId}-${testInfo.retry}@example.com`;

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await page.request.post(
        `${API_BASE_URL}/api/auth/email-otp/send-verification-otp`,
        {
          data: { email, type: 'sign-in' },
          headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
        }
      );
      statuses.push(res.status());
    }

    // The cap is 6/hour, so the first six are admitted — whatever Better-Auth
    // makes of them is this test's business only insofar as it isn't a 429.
    expect(statuses.slice(0, 6)).not.toContain(429);
    expect(statuses[6]).toBe(429);
    expect(statuses[7]).toBe(429);
  });
});
