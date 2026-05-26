import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('auth: sign-out', () => {
  test.beforeEach(resetAuthRateLimit);

  test('signed-in user can sign out and is no longer authenticated', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });

    let sessionRes = await page.request.get(`${API_BASE_URL}/api/auth/get-session`);
    const sessionBody = (await sessionRes.json()) as { user?: { id?: string } };
    expect(sessionBody.user?.id).toBeDefined();

    const signOutRes = await page.request.post(`${API_BASE_URL}/api/auth/sign-out`, {
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      data: {},
    });
    expect(signOutRes.ok()).toBe(true);

    sessionRes = await page.request.get(`${API_BASE_URL}/api/auth/get-session`);
    const postSignOutBody = (await sessionRes.json()) as { user?: { id?: string } } | null;
    // Better-Auth returns a null body (not an object with `user: null`)
    // when there is no active session.
    expect(postSignOutBody?.user).toBeFalsy();
  });
});
