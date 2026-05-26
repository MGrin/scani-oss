import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('wallet-import: supported chains list', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('walletRouter.getSupportedChains returns at least Ethereum + Bitcoin + Solana', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });
    const res = await page.request.get(`${API_BASE_URL}/trpc/wallet.getSupportedChains`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as {
      result: { data: { chainId: string | number; name: string; type: string }[] };
    };
    const names = body.result.data.map((c) => c.name.toLowerCase());
    expect(names.some((n) => n.includes('ethereum'))).toBe(true);
    expect(names.some((n) => n.includes('bitcoin'))).toBe(true);
    expect(names.some((n) => n.includes('solana'))).toBe(true);
  });
});
