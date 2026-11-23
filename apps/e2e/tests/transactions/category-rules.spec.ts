import type { Page } from '@playwright/test';

type RulePreview = {
  previewId: string;
  changed: number;
  rows: Array<{ transactionId: string; afterCategoryId: string }>;
};
type SavedCategoryRule = { id: string };

import { signIn } from '../../fixtures/auth';
import { expect, test } from '../../fixtures/test';
import { createAccount, trpcMutate, waitForJob } from '../../fixtures/ui';

const API = process.env.API_BASE_URL ?? 'http://localhost:3011';
async function read<T>(
  page: Page,
  procedure: string,
  input: Record<string, unknown> = {}
): Promise<T> {
  const response = await page.request.get(
    `${API}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: { data: T } }).result.data;
}
async function importCsv(page: Page, accountId: string) {
  const csv =
    'date,description,amount,currency\n2026-11-10,Cafe Example,-4.50,USD\n2026-11-11,Cafe Example,-7.25,USD\n2026-11-12,Cafe Example,-9.75,USD\n2026-11-13,Cafe Example,300.00,USD\n';
  const presign = await trpcMutate<{
    uploadUrl: string;
    key: string;
    headers: Record<string, string>;
  }>(page, 'storage.getUploadUrl', {
    purpose: 'file-import',
    contentType: 'text/csv',
    filename: 'category-rules.csv',
    sizeBytes: Buffer.byteLength(csv),
  });
  const uploaded = await page.request.put(presign.uploadUrl, {
    data: csv,
    headers: presign.headers,
  });
  expect(uploaded.ok()).toBe(true);
  const queued = await trpcMutate<{ jobId: string }>(page, 'fileImport.parseAndEnrich', {
    r2Key: presign.key,
    fileType: 'csv',
    accountId,
    requestId: crypto.randomUUID(),
  });
  expect((await waitForJob(page, queued.jobId, { timeoutMs: 60_000 })).state).toBe('completed');
}
test('saved account rules preview, apply, reload and category-only undo', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await signIn({ page, testInfo: info });
  const a = await createAccount(page, { name: 'Everyday saved rules' });
  const b = await createAccount(page, { name: 'Second saved rules' });
  await importCsv(page, a.id);
  await importCsv(page, b.id);
  const food = await trpcMutate<{ id: string }>(page, 'categories.create', { name: 'Cafes' });
  const travel = await trpcMutate<{ id: string }>(page, 'categories.create', { name: 'Travel' });
  const saved = await trpcMutate<SavedCategoryRule>(page, 'categories.rules.save', {
    accountId: a.id,
    categoryId: food.id,
    payeeText: 'Cafe Example',
    enabled: true,
  });
  await trpcMutate(page, 'categories.rules.save', {
    accountId: b.id,
    categoryId: travel.id,
    payeeText: 'Cafe Example',
    enabled: true,
  });
  const rows = await read<{
    transactions: Array<{
      id: string;
      quantity: string;
      categoryId: string | null;
      categorySetBy: string | null;
    }>;
  }>(page, 'transactions.list', { accountId: a.id, limit: 100 });
  const outgoing = rows.transactions.filter((r) => r.quantity.startsWith('-'));
  expect(outgoing).toHaveLength(3);
  await trpcMutate(page, 'transactions.setCategory', {
    ids: [outgoing[0]?.id],
    categoryId: travel.id,
  });
  await page.goto('/categories');
  await expect(page.getByRole('heading', { name: 'Saved rules', exact: true })).toBeVisible();
  await expect(page.getByText('cafe example', { exact: true })).toHaveCount(2);
  await page.reload();
  await expect(page.getByText('cafe example', { exact: true })).toHaveCount(2);
  await page.locator('#preview-account').selectOption(a.id);
  await page.locator('#rule-month').fill('2026-11');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('Only these reviewed transactions will change.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply 2 changes', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect
    .poll(async () => {
      const box = await page.getByRole('dialog').boundingBox();
      return box !== null && box.x > 800 && box.x + box.width <= 1281;
    })
    .toBe(true);
  await page.screenshot({ path: info.outputPath('preview-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const box = await page.getByRole('dialog').boundingBox();
      return box !== null && box.x >= 0 && box.width <= 390 && box.y < 200;
    })
    .toBe(true);
  await page.screenshot({ path: info.outputPath('preview-390x844.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Apply 2 changes', exact: true }).click();
  await expect(page.getByText('Applied 2 changes', { exact: true })).toBeVisible();
  const changed = await read<typeof rows>(page, 'transactions.list', {
    accountId: a.id,
    limit: 100,
  });
  expect(changed.transactions.filter((r) => r.categorySetBy === 'custom_rule')).toHaveLength(2);
  expect(changed.transactions.find((r) => r.id === outgoing[0]?.id)?.categoryId).toBe(travel.id);
  await trpcMutate(page, 'categories.rules.remove', { id: saved.id, expectedRevision: 1 });
  await page.reload();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Undid 2 changes', { exact: true })).toBeVisible();
  expect(
    (
      await read<typeof rows>(page, 'transactions.list', { accountId: a.id, limit: 100 })
    ).transactions.filter((r) => r.categorySetBy === 'custom_rule')
  ).toHaveLength(0);
  const scoped = await trpcMutate<RulePreview>(page, 'categories.rules.preview', {
    accountId: b.id,
    from: '2026-11-01T00:00:00Z',
    to: '2026-12-01T00:00:00Z',
  });
  expect(scoped.changed).toBe(3);
  expect(scoped.rows.every((r) => r.afterCategoryId === travel.id)).toBe(true);
  await trpcMutate(page, 'categories.rules.apply', { previewId: scoped.previewId });
  await trpcMutate(page, 'transactions.setCategory', {
    ids: [scoped.rows[0]?.transactionId],
    categoryId: food.id,
  });
  const refused = await page.request.post(`${API}/trpc/categories.rules.undo`, {
    data: { operationId: scoped.previewId },
    headers: { origin: 'http://localhost:5173' },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.text()).toContain('UNDO_CONFLICT');
  await page.goto('/transactions');
  await expect(page.getByRole('heading', { name: 'Transactions', exact: true })).toBeVisible();
  await expect(page.getByText('Cafe Example', { exact: true }).first()).toBeVisible();
  await page.screenshot({
    path: info.outputPath('transactions-sibling-390x844.png'),
    fullPage: true,
  });
});
