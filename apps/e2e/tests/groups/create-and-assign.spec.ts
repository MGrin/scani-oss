import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount, createHolding } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('groups: create + assign to a holding', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('user creates a group, assigns it to a holding, sees the link', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const holding = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1000',
    });

    // `CreateGroupDto` requires `name` + a hex `color`; tests pick a fixed
    // palette colour rather than randomising so failures stay deterministic.
    // `name` is capped at 50 chars by the DTO, and Playwright `testId` is
    // ~33 chars, so the prefix has to stay short.
    const groupName = `e2e-Ret-${testInfo.testId}`;
    const createRes = await page.request.post(`${API_BASE_URL}/trpc/groups.create`, {
      data: { name: groupName, color: '#22c55e' },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(createRes.ok()).toBe(true);
    const createBody = (await createRes.json()) as { result: { data: { id: string } } };
    const groupId = createBody.result.data.id;

    const assignRes = await page.request.post(`${API_BASE_URL}/trpc/groups.assignHoldingGroups`, {
      data: { holdingId: holding.id, groupIds: [groupId] },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(assignRes.ok()).toBe(true);

    const linkRes = await page.request.get(
      `${API_BASE_URL}/trpc/groups.getHoldingGroups?input=${encodeURIComponent(
        JSON.stringify({ id: holding.id })
      )}`
    );
    const linkBody = (await linkRes.json()) as { result: { data: { id: string }[] } };
    expect(linkBody.result.data.some((g) => g.id === groupId)).toBe(true);
  });
});
