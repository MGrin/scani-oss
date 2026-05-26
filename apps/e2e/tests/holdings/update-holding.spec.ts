import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount, createHolding } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

interface HoldingsListResponse {
  result: {
    data: {
      holdings: Array<{
        id: string;
        amount: number;
        token: { symbol: string };
      }>;
    };
  };
}

test.describe('holdings: update', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('user can update balance; change persists across reload', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const holding = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1000',
    });

    // `holdings.update` takes `{ id, data: UpdateHoldingDto }` where the
    // DTO field is `balance` (not `quantity`). The API normalises the
    // stored value back to `amount` on the read path.
    const updateRes = await page.request.post(`${API_BASE_URL}/trpc/holdings.update`, {
      data: { id: holding.id, data: { balance: '1500' } },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(updateRes.ok()).toBe(true);

    const listRes = await page.request.get(
      `${API_BASE_URL}/trpc/holdings.getWithDetails?input=%7B%7D`
    );
    const body = (await listRes.json()) as HoldingsListResponse;
    const updated = body.result.data.holdings.find((h) => h.id === holding.id);
    expect(updated).toBeTruthy();
    expect(updated?.amount).toBe(1500);
  });
});
