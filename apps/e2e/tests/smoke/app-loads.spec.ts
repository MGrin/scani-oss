import { expect, test } from '@playwright/test';

test.describe('smoke: app loads', () => {
  test('anonymous GET / responds 200 and shows the Sign in CTA', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    // The auth landing renders an email form — "Continue with Email" is the
    // universal anonymous landing affordance. The SPA may serve this at /
    // directly or after redirecting to /auth; either way the button appears.
    await expect(page.getByRole('button', { name: /continue with email/i })).toBeVisible({
      timeout: 10_000,
    });
  });
});
