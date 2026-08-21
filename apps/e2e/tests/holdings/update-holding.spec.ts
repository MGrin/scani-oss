import type { Page } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { expect, test } from '../../fixtures/test';
import { createAccount, createHolding } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

interface TokenSearchHit {
  id?: string;
  symbol: string;
  source: 'database' | 'external';
  provider?: 'finnhub' | 'coingecko' | 'defillama';
  metadata?: Record<string, unknown>;
}

interface HoldingsListResponse {
  result: {
    data: {
      holdings: Array<{
        id: string;
        amount: number;
        token: { symbol: string };
        manualEditCause?: string | null;
      }>;
    };
  };
}

test.describe('holdings: update', () => {
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
    //
    // `editCause` is required here and would not have been before SC-510.
    // USD is fiat, and on fiat the quantity IS the money: a 500 rise could be
    // a deposit, a corrected figure, or interest, and the API refuses to pick
    // rather than booking a wrong number that renders as a plausible one. The
    // refusal itself is asserted below.
    const updateRes = await page.request.post(`${API_BASE_URL}/trpc/holdings.update`, {
      data: { id: holding.id, data: { balance: '1500', editCause: 'flow' } },
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
    // And the answer is remembered, so the next edit of this pot is one tap.
    expect(updated?.manualEditCause).toBe('flow');
  });

  /**
   * The half that keeps the refusal honest (SC-510).
   *
   * A balance edit whose cause nobody stated, on a holding whose cause cannot
   * be derived, has to fail loudly. Defaulting it to a flow would be right
   * almost every time and wrong on exactly the case that matters — the
   * interest credit that looks identical to a deposit — and that wrongness
   * prints as a flat, believable return rather than as an error.
   *
   * Asserted through the API rather than the UI because the SPA never
   * produces this request: it shows the three-way control for the same set of
   * holdings the server refuses for. This is the contract for anything that
   * does not.
   */
  test('a balance edit with no stated cause is refused, not guessed at', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const holding = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1000',
    });

    const res = await page.request.post(`${API_BASE_URL}/trpc/holdings.update`, {
      data: { id: holding.id, data: { balance: '1500' } },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(res.status()).toBe(400);

    // And nothing moved. A refusal that half-applied would be worse than
    // either answer.
    const listRes = await page.request.get(
      `${API_BASE_URL}/trpc/holdings.getWithDetails?input=%7B%7D`
    );
    const body = (await listRes.json()) as HoldingsListResponse;
    expect(body.result.data.holdings.find((h) => h.id === holding.id)?.amount).toBe(1000);
  });

  /**
   * The benign case that shares the signal, and the test to delete last.
   *
   * "No `editCause` means refuse" would be a clean rule and it is not the
   * rule. A holding whose price we fetch has a channel for performance that
   * is not the number being edited, so a quantity edit there is unambiguously
   * a flow and the server derives it. Without this test, a future tightening
   * that refused every uncaused edit would look correct — the refusal test
   * above would still pass — while making the common case unusable.
   *
   * It costs an extra step because `createHolding` needs a token that is
   * already IN the database, and the seed only carries fiat. Every non-fiat
   * token in the product arrives the same way this one does: the user picks
   * an external search hit and `tokens.createFromExternal` materialises it.
   * Driving that path is the point rather than the overhead — a crypto
   * holding created any other way would not be one a user could own.
   */
  test('a priced holding needs no stated cause', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });
    await materializeExternalToken(page, 'BTC');

    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const holding = await createHolding(page, {
      accountId: account.id,
      symbol: 'BTC',
      quantity: '1',
    });

    const res = await page.request.post(`${API_BASE_URL}/trpc/holdings.update`, {
      data: { id: holding.id, data: { balance: '2' } },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(res.ok()).toBe(true);
  });
});

/**
 * Pull an external token search hit into the database, the same way the manual
 * -entry UI does when the user picks a CoinGecko result.
 *
 * No-op when the symbol is already a `database` hit, so the second worker to
 * reach it pays nothing. Throws with the hits it actually saw when the symbol
 * is nowhere — a silent skip here would leave the test above passing without
 * ever having exercised a priced holding, which is the one outcome worse than
 * it failing.
 */
async function materializeExternalToken(page: Page, symbol: string): Promise<void> {
  const input = encodeURIComponent(JSON.stringify({ query: symbol, limit: 10 }));
  const res = await page.request.get(`${API_BASE_URL}/trpc/tokens.search?input=${input}`);
  expect(res.ok()).toBe(true);
  const { result } = (await res.json()) as { result: { data: TokenSearchHit[] } };

  const matches = (hit: TokenSearchHit) => hit.symbol.toUpperCase() === symbol.toUpperCase();
  if (result.data.some((hit) => hit.source === 'database' && matches(hit))) return;

  const external = result.data.find(
    (hit) =>
      hit.source === 'external' &&
      matches(hit) &&
      (hit.provider === 'coingecko' || hit.provider === 'finnhub')
  );
  if (!external) {
    const seen = result.data.map((hit) => `${hit.symbol}/${hit.source}`).join(', ');
    throw new Error(`no materializable "${symbol}" in token search; saw: ${seen || '<nothing>'}`);
  }

  const created = await page.request.post(`${API_BASE_URL}/trpc/tokens.createFromExternal`, {
    data: {
      symbol: external.symbol,
      metadata: external.metadata ?? {},
      provider: external.provider,
    },
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
  });
  expect(created.ok()).toBe(true);
}
