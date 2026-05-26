import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('sessions: revoke rate limit', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('11th sessions.revoke call within a minute returns 429', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await page.request.post(`${API_BASE_URL}/trpc/sessions.revoke`, {
        data: { token: 'bogus-token-for-rate-test' },
        headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      });
      statuses.push(res.status());
    }

    // First 10 calls: 404 (NOT_FOUND from ownership check) — budget consumed
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    // 11th + 12th: 429 (rate-limited)
    expect(statuses[10]).toBe(429);
    expect(statuses[11]).toBe(429);
  });
});
