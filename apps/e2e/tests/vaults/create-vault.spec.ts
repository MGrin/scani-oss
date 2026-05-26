import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = 'http://localhost:5173';

interface SupportedCurrency {
  id: string;
  symbol: string;
  name: string;
}

interface VaultListRow {
  id: string;
  name: string;
}

/**
 * Vaults are per-user "savings buckets" with a target amount in a chosen
 * fiat currency. The user-facing flow is a modal on `/v2/vaults` that
 * fires `vaults.create` with `{ name, targetAmount, currencyId, color }`
 * (+ optional `iconName` / `description`). We exercise the same tRPC
 * call directly and assert the new row shows up in `vaults.getAll`.
 *
 * The `vaults` table has a `(userId, name)` UNIQUE constraint, but
 * `signIn` mints a fresh user per test so cross-test name collisions
 * are physically impossible. We still suffix the name with
 * `testId-project.name` to match the rest of the suite (Playwright
 * reuses the same `testId` across chromium / webkit projects, so the
 * suffix keeps debug output unambiguous).
 */
test.describe('vaults: create + list', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('user creates a vault and it appears in vaults.getAll', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });

    // Pick the first seeded fiat token as the vault's currency. The
    // SPA's vault-create modal uses the same `users.getSupportedCurrencies`
    // endpoint to populate its currency picker.
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

    const projectTag = `${testInfo.testId}-${testInfo.project.name}`;
    const vaultName = `e2e-Vault-${projectTag}`.slice(0, 100);

    const createRes = await page.request.post(`${API_BASE_URL}/trpc/vaults.create`, {
      data: {
        name: vaultName,
        targetAmount: '10000',
        currencyId: currency.id,
        color: '#22c55e',
      },
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    if (!createRes.ok()) {
      throw new Error(`vaults.create failed: ${createRes.status()} ${await createRes.text()}`);
    }
    const createBody = (await createRes.json()) as { result: { data: { id: string } } };
    const vaultId = createBody.result.data.id;

    const listRes = await page.request.get(`${API_BASE_URL}/trpc/vaults.getAll?input=%7B%7D`);
    expect(listRes.ok()).toBe(true);
    const listBody = (await listRes.json()) as { result: { data: VaultListRow[] } };
    const created = listBody.result.data.find((v) => v.id === vaultId);
    expect(created).toBeTruthy();
    expect(created?.name).toBe(vaultName);
  });
});
