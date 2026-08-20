import { signIn } from '../../fixtures/auth';
import { expect, test } from '../../fixtures/test';
import { createAccount, gotoAccountPeek } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('accounts: update', () => {
  test('user can rename an account; change persists across reload', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });
    const created = await createAccount(page, {
      name: `e2e-orig-${testInfo.testId}`,
      institutionName: 'JPMorgan Chase',
    });
    const newName = `e2e-renamed-${testInfo.testId}`;

    const updateRes = await page.request.post(`${API_BASE_URL}/trpc/accounts.update`, {
      data: { id: created.id, data: { name: newName } },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(updateRes.ok()).toBe(true);

    const listRes = await page.request.get(`${API_BASE_URL}/trpc/accounts.getAll?input=%7B%7D`);
    const listBody = (await listRes.json()) as { result: { data: { id: string; name: string }[] } };
    const renamed = listBody.result.data.find((a) => a.id === created.id);
    expect(renamed?.name).toBe(newName);

    // UI assertion: opening the record after the rename shows the new name,
    // proving the change was persisted (not just acked).
    await gotoAccountPeek(page, created.id);
    await expect(page.getByRole('heading', { name: newName })).toBeVisible();
  });
});
