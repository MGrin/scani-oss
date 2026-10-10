import { signIn } from '../../fixtures/auth';
import { expect, test } from '../../fixtures/test';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = 'http://localhost:5173';

/**
 * A property, end to end (SC-1643): created from its purchase, then valued
 * again today. The holdings read — what Home and MCP total — carries the new
 * value, and the asset's history the gain since purchase. Priced in the
 * user's own base currency, so no exchange rate is needed in a fresh stack.
 */
test.describe('assets: add a property', () => {
  test('user adds a property and values it again', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });
    const headers = { 'content-type': 'application/json', origin: ORIGIN };
    const get = async (path: string, input: unknown) => {
      const res = await page.request.get(
        `${API_BASE_URL}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
      );
      expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
      return (await res.json()).result.data;
    };
    const post = async (path: string, input: unknown) => {
      const res = await page.request.post(`${API_BASE_URL}/trpc/${path}`, { data: input, headers });
      expect(res.ok(), await res.text()).toBe(true);
      return (await res.json()).result.data;
    };

    const base = await get('users.getBaseCurrency', {});
    const name = `e2e-flat-${Date.now()}`;
    const { holdingId } = await post('valuedAssets.create', {
      asset: {
        name,
        currencyCode: base.symbol,
        purchaseDate: '2020-01-01',
        purchasePrice: '300000',
        currentValue: '350000',
        details: { kind: 'property', address: 'Rua X 1', areaSqm: 72 },
      },
    });
    const today = new Date().toISOString().slice(0, 10);
    await post('valuedAssets.addValuation', {
      valuation: { holdingId, occurredOn: today, value: '360000' },
    });

    const history = await get('valuedAssets.history', { holdingId });
    expect(history.current).toBe('360000');
    expect(history.gain).toBe('60000');

    const holdings = await get('holdings.getWithDetails', {});
    const row = holdings.holdings.find((h: { id: string }) => h.id === holdingId);
    expect(row).toBeTruthy();
    expect(Number(row.value)).toBe(360000);

    await page.goto('/assets/new');
    await expect(page.getByRole('heading', { name: 'Add a property or vehicle' })).toBeVisible();
  });
});
