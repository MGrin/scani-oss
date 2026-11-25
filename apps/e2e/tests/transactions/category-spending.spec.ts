import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { queryDb } from '../../fixtures/db';
import { expect, isolatedContextOptions, test } from '../../fixtures/test';
import { createAccount, trpcGet, trpcMutate, waitForJob } from '../../fixtures/ui';

async function importSpending(page: Page, accountId: string) {
  const csv = [
    'date,description,amount,currency',
    ...Array.from(
      { length: 55 },
      (_, i) =>
        `2026-01-15,Report merchant ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))},-1.00,USD`
    ),
    '2026-01-16,Recorded refund,8.00,USD',
  ].join('\n');
  const upload = await trpcMutate<{
    uploadUrl: string;
    key: string;
    headers: Record<string, string>;
  }>(page, 'storage.getUploadUrl', {
    purpose: 'file-import',
    contentType: 'text/csv',
    filename: 'synthetic-spending.csv',
    sizeBytes: Buffer.byteLength(csv),
  });
  expect(
    (await page.request.put(upload.uploadUrl, { data: csv, headers: upload.headers })).ok()
  ).toBe(true);
  const job = await trpcMutate<{ jobId: string }>(page, 'fileImport.parseAndEnrich', {
    r2Key: upload.key,
    fileType: 'csv',
    accountId,
    requestId: crypto.randomUUID(),
  });
  expect((await waitForJob(page, job.jobId, { timeoutMs: 60_000 })).state).toBe('completed');
}

test('gross category report and bounded drilldown work with synthetic data on desktop and phone', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const owner = await signIn({ page, testInfo: info });
  const account = await createAccount(page, { name: 'Report everyday' });
  await importSpending(page, account.id);
  const food = await trpcMutate<{ id: string }>(page, 'categories.create', { name: 'Report food' });
  const child = await trpcMutate<{ id: string }>(page, 'categories.create', {
    name: 'Groceries',
    parentId: food.id,
  });
  const ledger = await trpcGet<{
    transactions: { id: string; quantity: string; tokenId: string }[];
  }>(page, 'transactions.list', { accountId: account.id, limit: 100 });
  const outgoing = ledger.transactions.filter((row) => row.quantity.startsWith('-'));
  expect(outgoing).toHaveLength(55);
  await trpcMutate(page, 'transactions.setCategory', {
    ids: outgoing.map((row) => row.id),
    categoryId: null,
  });
  await trpcMutate(page, 'transactions.setCategory', {
    ids: outgoing.slice(0, 52).map((row) => row.id),
    categoryId: food.id,
  });
  await trpcMutate(page, 'transactions.setCategory', {
    ids: [outgoing[0]?.id],
    categoryId: child.id,
  });
  const fees = await trpcMutate<{ id: string }>(page, 'categories.create', { name: 'Report fees' });
  await trpcMutate(page, 'transactions.setCategory', {
    ids: [outgoing[52]?.id],
    categoryId: fees.id,
  });
  const input = { month: '2026-01', accountId: account.id };
  const report = await trpcGet<{
    currencies: {
      total: string;
      count: number;
      categories: { categoryId: string | null; total: string }[];
    }[];
  }>(page, 'transactions.spending', input);
  expect(report.currencies[0]?.total).toBe('55');
  expect(report.currencies[0]?.count).toBe(55);
  expect(
    report.currencies[0]?.categories.find((category) => category.categoryId === food.id)?.total
  ).toBe('52');
  expect(
    await queryDb(
      `select trim_scale(sum(-quantity::numeric))::text from holding_transactions where user_id = '${owner.userId}' and holding_id in (select id from holdings where account_id = '${account.id}') and kind = 'withdraw' and quantity::numeric < 0`
    )
  ).toEqual(['55']);

  await page.goto('/payments');
  const navigationStarted = Date.now();
  await page.getByRole('link', { name: 'Spending by category', exact: true }).click();
  await page.getByLabel('Month', { exact: true }).fill('2026-01');
  await expect(page.getByRole('heading', { name: 'USD', exact: true })).toBeVisible();
  const firstReportMs = Date.now() - navigationStarted;
  const categoryLink = page.getByRole('link').filter({ hasText: 'Report food' });
  await expect(categoryLink).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(async () => (await categoryLink.boundingBox())?.y ?? 9999).toBeLessThan(850);
  const feesLink = page.getByRole('link').filter({ hasText: 'Report fees' });
  const uncategorizedLink = page.getByRole('link').filter({ hasText: 'Uncategorized' });
  await expect(uncategorizedLink).toBeVisible();
  const desktopThird = await uncategorizedLink.boundingBox();
  expect((desktopThird?.y ?? 9999) + (desktopThird?.height ?? 0)).toBeLessThan(900);
  await page.screenshot({ path: info.outputPath('overview-desktop.png'), fullPage: true });
  await categoryLink.click();
  await expect(page.getByText('Transactions 1–50 of 52 · live', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Transactions 51–52 of 52 · live', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Previous', exact: true }).click();
  await expect(page.getByText('Transactions 1–50 of 52 · live', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('detail-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('summary')
    .filter({ hasText: 'Exact record' })
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    page.getByText('2026-01-15T00:00:00.000000Z', { exact: true }).filter({ visible: true }).first()
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('detail-phone.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const monthBox = await page.getByLabel('Month', { exact: true }).boundingBox();
  expect(monthBox?.height).toBeGreaterThanOrEqual(44);
  const violations = (await new AxeBuilder({ page }).include('main').analyze()).violations.filter(
    (violation) => ['critical', 'serious'].includes(violation.impact ?? '')
  );
  expect(violations).toEqual([]);
  await page.reload();
  await expect(page.getByText('Transactions 1–50 of 52 · live', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to categories', exact: true }).click();
  await expect(categoryLink).toBeFocused();
  const phoneSecond = await feesLink.boundingBox();
  expect((phoneSecond?.y ?? 9999) + (phoneSecond?.height ?? 0)).toBeLessThan(844);
  const pointerCoarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  for (const control of [categoryLink, feesLink, page.getByRole('combobox')]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(pointerCoarse ? 44 : 40);
  }
  const metrics = {
    desktopThird,
    phoneSecond,
    monthBox,
    pointerCoarse,
    firstReportMs,
    seriousAxeViolations: violations.length,
  };
  console.info('category-spending-acceptance', JSON.stringify(metrics));
  await info.attach('acceptance-metrics', {
    body: JSON.stringify(metrics),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('overview-phone.png'), fullPage: true });
  await page.route('**/trpc/transactions.spending*', (route) =>
    route.fulfill({ status: 500, body: 'Synthetic read failure' })
  );
  await page.reload();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Spending could not be loaded' })
  ).toBeVisible({ timeout: 20_000 });
  await page.unroute('**/trpc/transactions.spending*');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(categoryLink).toBeVisible();
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Month', { exact: true }).fill('2025-12');
  await expect(
    page.getByText('No recorded spending for this month.', { exact: true })
  ).toBeVisible();

  const otherContext = await browser.newContext(isolatedContextOptions(info, 'spending-other'));
  try {
    const otherPage = await otherContext.newPage();
    await signIn({ page: otherPage, testInfo: info, label: 'spending-other' });
    const response = await otherPage.request.get(
      `${process.env.API_BASE_URL ?? 'http://localhost:3011'}/trpc/transactions.spending?input=${encodeURIComponent(JSON.stringify(input))}`
    );
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain('Report everyday');
  } finally {
    await otherContext.close();
  }
});
