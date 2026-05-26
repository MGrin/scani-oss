import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount } from '../../fixtures/ui';

test.describe('accounts: add manual account', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('user can create an account and view its detail page', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });

    const accountName = `e2e-acct-${testInfo.testId}`;
    const account = await createAccount(page, {
      name: accountName,
      institutionName: 'JPMorgan Chase',
    });
    expect(account.id).toBeTruthy();
    expect(account.name).toBe(accountName);

    // The account-detail page renders the account name as an h2 heading.
    // Hitting it via URL avoids the AccountsPage's default "hide accounts
    // with zero holdings" filter, which would otherwise mask a freshly
    // created (and therefore empty) account.
    await page.goto(`/accounts/${account.id}`);
    await expect(page.getByRole('heading', { name: accountName })).toBeVisible();
  });
});
