import type { Page } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { delayApi, lateMoves, paintedContent, watchLayout } from '../../fixtures/layout-shift';
import { expect, test } from '../../fixtures/test';
import { createAccount, createHolding, trpcMutate } from '../../fixtures/ui';

/**
 * SC-1742. Home and Settings loaded "jumpy and not in sync": once a page had
 * shown content, later answers pushed it around. On Home the household row
 * landed above the tiles seconds after first paint, moving everything below
 * it, and a slow Gains query held five unrelated tiles in its HTTP batch.
 *
 * The rule: once content is on screen, nothing on the page moves. A section
 * may fill in later; it may not push another section.
 */
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** A phone round trip, and the Gains and Returns engine running slow. */
const PHONE = {
  roundTripMs: 300,
  slow: /^portfolio\.(getGainsByWrapper|getReturns|getReturnsComparison)$/,
  slowMs: 3000,
};

/**
 * Every answer later than the tiles' 1 s reveal cap, as on a loaded CI runner.
 * A tile that turned out empty used to show its skeleton here and then leave,
 * moving every tile after it up (SC-1773).
 */
const SLOW_BACKEND = { ...PHONE, roundTripMs: 1500 };

test.beforeEach(async ({ page }, testInfo) => {
  await signIn({ page, testInfo });
  const account = await createAccount(page, {
    name: `e2e-load-${testInfo.testId}`,
    institutionName: 'JPMorgan Chase',
  });
  await createHolding(page, { accountId: account.id, symbol: 'USD', quantity: '1000' });
  await trpcMutate(page, 'household.create', { name: 'Load household' });
  await watchLayout(page);
});

async function expectHoldsStill(page: Page, path: string, profile: typeof PHONE): Promise<void> {
  await delayApi(page, API_BASE_URL, profile);
  await page.goto(path);
  await page.locator('main').waitFor();
  // Long enough for the slow lane to answer and its section to settle.
  await page.waitForTimeout(profile.roundTripMs + profile.slowMs + 2000);
  expect(await paintedContent(page), 'the page never showed content').toBe(true);
  const moves = await lateMoves(page);
  expect(
    moves,
    `moved after first content: ${moves.map((m) => `${m.at}ms ${m.by}px "${m.label}"`).join('; ')}`
  ).toEqual([]);
}

for (const path of ['/', '/settings/you', '/settings/data']) {
  test(`${path} holds still once it has shown content`, async ({ page }) => {
    await expectHoldsStill(page, path, PHONE);
  });
}

test('/ holds still when every answer is slower than the tile cap', async ({ page }) => {
  await expectHoldsStill(page, '/', SLOW_BACKEND);
});
