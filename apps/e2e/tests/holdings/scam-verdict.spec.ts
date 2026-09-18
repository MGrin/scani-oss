import type { Page } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { expect, isolatedContextOptions, test } from '../../fixtures/test';
import { createAccount, createHolding } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

interface HoldingsListResponse {
  result: { data: { holdings: Array<{ id: string }> } };
}

async function visibleHoldingIds(page: Page): Promise<string[]> {
  const res = await page.request.get(`${API_BASE_URL}/trpc/holdings.getWithDetails?input=%7B%7D`);
  const body = (await res.json()) as HoldingsListResponse;
  return body.result.data.holdings.map((h) => h.id);
}

/**
 * SC-1160, end to end: a scam verdict is the reader's own (mgrin, 2026-09-14).
 *
 * Two users hold the same token. One marks it as a scam from the holding sheet
 * and clears it again from the hidden list, through the real UI; the other is
 * read through the API after each step. The second user is the point — the
 * `Not a scam` this replaces un-flagged the token for every Scani user, and a
 * test that watched only the first user could not tell the two builds apart.
 */
test.describe('holdings: a scam verdict is per user', () => {
  test('marking and clearing a scam changes only the reader’s own portfolio', async ({
    page,
    browser,
  }, testInfo) => {
    await signIn({ page, testInfo });
    const mine = await createHolding(page, {
      accountId: (await createAccount(page, { name: `e2e-a-${testInfo.testId}` })).id,
      symbol: 'USD',
      quantity: '1000',
    });

    const otherContext = await browser.newContext(isolatedContextOptions(testInfo, 'other-user'));
    const other = await otherContext.newPage();
    await signIn({ page: other, testInfo });
    const theirs = await createHolding(other, {
      accountId: (await createAccount(other, { name: `e2e-b-${testInfo.testId}` })).id,
      symbol: 'USD',
      quantity: '1000',
    });

    await page.goto(`/holdings/${mine.id}`);
    // On a phone the peek rests at half height and `Mark as scam` lives in its
    // scrolling body, below that fold; expanding is what a reader does to reach
    // it. The desktop sheet has no such control and shows the body whole.
    // Keyed on the width the drawer is used below (`lg`), not on whether the
    // control is visible yet: that reads false while the drawer animates in.
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.getByRole('button', { name: 'Show full detail' }).click();
    }
    await page.getByRole('button', { name: 'Mark as scam', exact: true }).click();
    await page.getByRole('button', { name: 'Mark USD as a scam' }).click();

    await expect.poll(() => visibleHoldingIds(page)).not.toContain(mine.id);
    expect(await visibleHoldingIds(other)).toContain(theirs.id);

    await page.goto('/tokens');
    await page.getByRole('radio', { name: 'Hidden' }).click();
    // The same row is a table cell on desktop and a button on a phone or
    // tablet, whose name starts with the symbol and whose text has no node
    // that is exactly `USD` (iPad e2e). Either is the row to open.
    await page
      .getByRole('button', { name: /^USD\b/ })
      .or(page.getByText('USD', { exact: true }))
      .first()
      .click();
    await page.getByRole('button', { name: 'Not a scam' }).click();

    await expect.poll(() => visibleHoldingIds(page)).toContain(mine.id);
    expect(await visibleHoldingIds(other)).toContain(theirs.id);

    await otherContext.close();
  });
});
