import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount, createHolding } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('groups: delete', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('deleting a group removes it from all holdings it was on', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const holding = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1000',
    });

    const groupName = `e2e-Del-${testInfo.testId}`;
    const createRes = await page.request.post(`${API_BASE_URL}/trpc/groups.create`, {
      data: { name: groupName, color: '#ef4444' },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    const groupId = ((await createRes.json()) as { result: { data: { id: string } } }).result.data
      .id;

    await page.request.post(`${API_BASE_URL}/trpc/groups.assignHoldingGroups`, {
      data: { holdingId: holding.id, groupIds: [groupId] },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });

    const delRes = await page.request.post(`${API_BASE_URL}/trpc/groups.delete`, {
      data: { id: groupId },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(delRes.ok()).toBe(true);

    const linkRes = await page.request.get(
      `${API_BASE_URL}/trpc/groups.getHoldingGroups?input=${encodeURIComponent(
        JSON.stringify({ id: holding.id })
      )}`
    );
    const linkBody = (await linkRes.json()) as { result: { data: { id: string }[] } };
    expect(linkBody.result.data.some((g) => g.id === groupId)).toBe(false);
  });
});
