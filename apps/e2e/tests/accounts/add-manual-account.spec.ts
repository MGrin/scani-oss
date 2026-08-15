import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount, gotoAccountPeek } from '../../fixtures/ui';

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

    // `/accounts/<id>` opens the account's record as a peek over the list, and
    // that peek titles itself with the account name as a level-2 heading.
    // Addressing the record directly is what keeps a freshly created — and so
    // empty — account assertable at all: the list behind the peek filters on
    // holdings, and this account has none yet.
    await gotoAccountPeek(page, account.id);
    await expect(page.getByRole('heading', { name: accountName })).toBeVisible();
  });
});
