import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount, createHolding } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = 'http://localhost:5173';

interface SupportedCurrency {
  id: string;
  symbol: string;
  name: string;
}

interface VaultHoldingDetail {
  holdingId: string;
  percentage: number;
}

interface VaultWithProgress {
  id: string;
  name: string;
  holdingsCount: number;
  holdings: VaultHoldingDetail[];
}

interface HoldingWithDetails {
  id: string;
}

test.describe('vaults: detach a holding', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('detaching a holding empties the vault but the holding itself survives', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });

    const projectTag = `${testInfo.testId}-${testInfo.project.name}`;
    const account = await createAccount(page, { name: `e2e-acct-${projectTag}` });
    const holding = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1000',
    });

    const currenciesRes = await page.request.get(
      `${API_BASE_URL}/trpc/users.getSupportedCurrencies?input=%7B%7D`
    );
    expect(currenciesRes.ok()).toBe(true);
    const currenciesBody = (await currenciesRes.json()) as {
      result: { data: SupportedCurrency[] };
    };
    const currency =
      currenciesBody.result.data.find((c) => c.symbol === 'USD') ?? currenciesBody.result.data[0];
    if (!currency) throw new Error('No fiat currencies seeded');

    const vaultName = `e2e-Vault-${projectTag}`.slice(0, 100);
    const createRes = await page.request.post(`${API_BASE_URL}/trpc/vaults.create`, {
      data: {
        name: vaultName,
        targetAmount: '10000',
        currencyId: currency.id,
        color: '#ef4444',
      },
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    if (!createRes.ok()) {
      throw new Error(`vaults.create failed: ${createRes.status()} ${await createRes.text()}`);
    }
    const createBody = (await createRes.json()) as { result: { data: { id: string } } };
    const vaultId = createBody.result.data.id;

    const attachRes = await page.request.post(`${API_BASE_URL}/trpc/vaults.attachHolding`, {
      data: { vaultId, holdingId: holding.id, percentage: 100 },
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    if (!attachRes.ok()) {
      throw new Error(
        `vaults.attachHolding failed: ${attachRes.status()} ${await attachRes.text()}`
      );
    }

    const detachRes = await page.request.post(`${API_BASE_URL}/trpc/vaults.detachHolding`, {
      data: { vaultId, holdingId: holding.id },
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    if (!detachRes.ok()) {
      throw new Error(
        `vaults.detachHolding failed: ${detachRes.status()} ${await detachRes.text()}`
      );
    }

    // Vault is now empty.
    const getByIdInput = encodeURIComponent(JSON.stringify({ id: vaultId }));
    const getRes = await page.request.get(
      `${API_BASE_URL}/trpc/vaults.getById?input=${getByIdInput}`
    );
    expect(getRes.ok()).toBe(true);
    const getBody = (await getRes.json()) as { result: { data: VaultWithProgress } };
    expect(getBody.result.data.holdingsCount).toBe(0);
    expect(getBody.result.data.holdings).toHaveLength(0);

    // The holding itself still exists — detach removes the junction row,
    // not the holding.
    const holdingsRes = await page.request.get(
      `${API_BASE_URL}/trpc/holdings.getWithDetails?input=%7B%7D`
    );
    expect(holdingsRes.ok()).toBe(true);
    const holdingsBody = (await holdingsRes.json()) as {
      result: { data: { holdings: HoldingWithDetails[] } };
    };
    expect(holdingsBody.result.data.holdings.some((h) => h.id === holding.id)).toBe(true);
  });
});
