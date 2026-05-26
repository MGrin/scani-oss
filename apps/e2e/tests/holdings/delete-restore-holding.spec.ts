import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount, createHolding } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = 'http://localhost:5173';

interface HoldingsListResponse {
  result: {
    data: {
      holdings: Array<{ id: string }>;
    };
  };
}

interface HiddenHoldingsResponse {
  result: {
    data: Array<{ id: string }>;
  };
}

test.describe('holdings: delete + restore', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('deleted holding disappears; can be re-added (delete is destructive, not soft-hide)', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const holding = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1000',
    });

    // `holdings.delete` cascades to transactions — it removes the row,
    // it does NOT soft-hide. The "hidden" channel is for user-flagged
    // (`holdings.update { isActive: false }`) or scam-flagged rows.
    // We therefore can't follow delete → getHidden → restore as the
    // task spec proposed; instead we verify the row vanishes from the
    // main list after delete, and that the same token can be re-added
    // to the same account (proving the delete really released it).
    const delRes = await page.request.post(`${API_BASE_URL}/trpc/holdings.delete`, {
      data: { id: holding.id },
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    expect(delRes.ok()).toBe(true);

    const visibleRes = await page.request.get(
      `${API_BASE_URL}/trpc/holdings.getWithDetails?input=%7B%7D`
    );
    const visibleBody = (await visibleRes.json()) as HoldingsListResponse;
    expect(visibleBody.result.data.holdings.some((h) => h.id === holding.id)).toBe(false);

    const hiddenRes = await page.request.get(
      `${API_BASE_URL}/trpc/holdings.getHidden?input=%7B%7D`
    );
    const hiddenBody = (await hiddenRes.json()) as HiddenHoldingsResponse;
    expect(hiddenBody.result.data.some((h) => h.id === holding.id)).toBe(false);

    // Restore path: create a fresh holding for the same (account, token)
    // pair — `createHoldingsBatch` allows it because the prior row is
    // truly gone, not soft-hidden.
    const restored = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '2000',
    });
    expect(restored.id).toBeTruthy();
    expect(restored.id).not.toBe(holding.id);

    const afterRes = await page.request.get(
      `${API_BASE_URL}/trpc/holdings.getWithDetails?input=%7B%7D`
    );
    const afterBody = (await afterRes.json()) as HoldingsListResponse;
    expect(afterBody.result.data.holdings.some((h) => h.id === restored.id)).toBe(true);
  });
});
