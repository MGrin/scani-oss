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

  test('initial load has no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      errors.push(`pageerror: ${err.message}`);
    });
    await page.goto('/');
    // Wait 3s for async errors (SDK init, lazy hydration).
    await page.waitForTimeout(3_000);
    expect(errors, `Unexpected console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
