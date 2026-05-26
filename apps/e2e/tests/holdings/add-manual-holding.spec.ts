import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount, createHolding } from '../../fixtures/ui';

test.describe('holdings: add manual', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('user can add a USD cash holding to an existing account', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const holding = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1000',
    });
    expect(holding.id).toBeTruthy();
    expect(holding.symbol.toUpperCase()).toBe('USD');
    expect(holding.accountId).toBe(account.id);
  });
});
