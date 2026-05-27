import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount, createHolding } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('groups: bulk assign', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('group bulk-assigned to multiple holdings shows on all', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const h1 = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1000',
    });
    const h2 = await createHolding(page, {
      accountId: account.id,
      symbol: 'EUR',
      quantity: '500',
    });

    const groupName = `e2e-Bulk-${testInfo.testId}`;
    const createRes = await page.request.post(`${API_BASE_URL}/trpc/groups.create`, {
      data: { name: groupName, color: '#3b82f6' },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    const groupId = ((await createRes.json()) as { result: { data: { id: string } } }).result.data
      .id;

    // `holdings.bulkAssignGroups` uses an explicit diff API
    // (`addedGroupIds` / `removedGroupIds`) rather than REPLACE semantics.
    const bulkRes = await page.request.post(`${API_BASE_URL}/trpc/holdings.bulkAssignGroups`, {
      data: { holdingIds: [h1.id, h2.id], addedGroupIds: [groupId], removedGroupIds: [] },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(bulkRes.ok()).toBe(true);

    for (const holdingId of [h1.id, h2.id]) {
      const res = await page.request.get(
        `${API_BASE_URL}/trpc/groups.getHoldingGroups?input=${encodeURIComponent(
          JSON.stringify({ id: holdingId })
        )}`
      );
      const body = (await res.json()) as { result: { data: { id: string }[] } };
      expect(body.result.data.some((g) => g.id === groupId)).toBe(true);
    }
  });
});
