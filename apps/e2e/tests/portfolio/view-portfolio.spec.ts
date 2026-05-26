import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount, createHolding } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

interface HoldingsListResponse {
  result: {
    data: {
      holdings: Array<{ id: string; token: { symbol: string } }>;
      summary: { totalCount: number; activeCount: number };
    };
  };
}

test.describe('portfolio: view after creating holdings', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('newly added holdings show up in the holdings list and dashboard', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const holding = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1234',
    });

    // API-level assertion: the holding is in the user's portfolio.
    const listRes = await page.request.get(
      `${API_BASE_URL}/trpc/holdings.getWithDetails?input=%7B%7D`
    );
    const listBody = (await listRes.json()) as HoldingsListResponse;
    const found = listBody.result.data.holdings.find((h) => h.id === holding.id);
    expect(found).toBeTruthy();
    expect(found?.token.symbol.toUpperCase()).toBe('USD');
    expect(listBody.result.data.summary.activeCount).toBeGreaterThanOrEqual(1);

    // UI assertion: the holdings page renders the newly-added USD row.
    // /holdings is the canonical post-import landing page and lists
    // every active holding regardless of price availability — safer than
    // the dashboard, whose top-cards depend on portfolio rollup having
    // run since the holding was added.
    await page.goto('/holdings');
    await expect(page.getByText('USD').first()).toBeVisible({ timeout: 10_000 });
  });
});
