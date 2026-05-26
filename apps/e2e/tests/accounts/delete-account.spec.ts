import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('accounts: delete', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('user can delete an account; it disappears from the list', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });
    const created = await createAccount(page, {
      name: `e2e-del-${testInfo.testId}`,
      institutionName: 'JPMorgan Chase',
    });

    const delRes = await page.request.post(`${API_BASE_URL}/trpc/accounts.delete`, {
      data: { id: created.id },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(delRes.ok()).toBe(true);

    const listRes = await page.request.get(`${API_BASE_URL}/trpc/accounts.getAll?input=%7B%7D`);
    const listBody = (await listRes.json()) as { result: { data: { id: string }[] } };
    expect(listBody.result.data.some((a) => a.id === created.id)).toBe(false);
  });
});
