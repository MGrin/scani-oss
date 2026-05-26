import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';

test.describe('auth: OTP sign-in', () => {
  test('end-to-end OTP flow lands the user on the dashboard', async ({ page }, testInfo) => {
    const { email, userId, page: signedInPage } = await signIn({ page, testInfo });

    // Navigate to the SPA root — the session cookie set by signIn should
    // make the dashboard render, not redirect to /auth.
    await signedInPage.goto('/');

    // Authenticated landing: URL should NOT be /auth.
    expect(new URL(signedInPage.url()).pathname).not.toBe('/auth');

    // Sanity: the API recognizes us via the same session cookie.
    const sessionRes = await signedInPage.request.get('http://localhost:3011/api/auth/get-session');
    expect(sessionRes.ok()).toBe(true);
    const sessionBody = (await sessionRes.json()) as { user?: { id?: string; email?: string } };
    expect(sessionBody.user?.id).toBe(userId);
    expect(sessionBody.user?.email).toBe(email);
  });
});
