import { expect, test } from '@playwright/test';
import { mailpit } from '../../fixtures/mailpit';
import { resetAuthRateLimit } from '../../fixtures/redis';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('auth: magic-link sign-in', () => {
  test.beforeEach(resetAuthRateLimit);

  test('clicking the magic link in the email signs the user in', async ({ page }, testInfo) => {
    const email = `e2e-ml-${testInfo.testId}-${Date.now()}@example.com`;

    const requestRes = await page.request.post(`${API_BASE_URL}/api/auth/sign-in/magic-link`, {
      data: { email, callbackURL: '/' },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(requestRes.ok()).toBe(true);

    const message = await mailpit.waitForMessageTo(email);
    const body = await mailpit.getBody(message.ID);
    const magicLinkUrl = mailpit.extractMagicLinkFromBody(body);

    const response = await page.goto(magicLinkUrl);
    expect(response?.status() ?? 0).toBeLessThan(400);

    const sessionRes = await page.request.get(`${API_BASE_URL}/api/auth/get-session`);
    const sessionBody = (await sessionRes.json()) as { user?: { email?: string } };
    expect(sessionBody.user?.email).toBe(email);
  });
});
