import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { createAccount, waitForJob } from '../../fixtures/ui';

// Playwright runs specs in ESM mode; `__dirname` isn't defined there.
const SPEC_DIR = dirname(fileURLToPath(import.meta.url));

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = 'http://localhost:5173';

interface PresignedUpload {
  uploadUrl: string;
  key: string;
  expiresAt: string;
  method: 'PUT';
  headers: Record<string, string>;
}

interface TransactionsListResponse {
  transactions: Array<{ id: string; description: string | null }>;
}

/**
 * E2E coverage for the file-import flow. The frontend's FileImportPage walks
 * the user through five steps (FileSelection → AccountSelection → ColumnMapping
 * → Preview → JobsView); under the hood the wizard hits the same two
 * endpoints we exercise here:
 *
 *   1. `storage.getUploadUrl` → presigned MinIO/R2 PUT URL scoped to
 *      `temp/file-import/{userId}/...`
 *   2. (PUT raw bytes to the presigned URL)
 *   3. `fileImport.parseAndEnrich` → enqueues a `file-import` BullMQ job
 *
 * We bypass the wizard UI because (a) the wizard's auto-detection /
 * column-mapping logic is unit-tested in `packages/business/file-import`,
 * and (b) driving it for one e2e would dominate runtime without adding
 * coverage the api / worker tests already provide. What matters here is
 * the full request → worker → DB chain works against a real stack.
 */
test.describe('imports: CSV file import', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('upload tiny CSV → worker ingests 3 transactions into the account', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-csv-${testInfo.testId}` });

    const csvPath = resolve(SPEC_DIR, '../../fixtures/data/transactions-sample.csv');
    const csvBytes = readFileSync(csvPath);
    const csvSize = statSync(csvPath).size;

    // 1. Presign upload URL via the api's storage router.
    const presignRes = await page.request.post(`${API_BASE_URL}/trpc/storage.getUploadUrl`, {
      data: {
        purpose: 'file-import',
        contentType: 'text/csv',
        filename: 'transactions-sample.csv',
        sizeBytes: csvSize,
      },
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    expect(
      presignRes.ok(),
      `presign failed: ${presignRes.status()} ${await presignRes.text()}`
    ).toBe(true);
    const presignBody = (await presignRes.json()) as { result: { data: PresignedUpload } };
    const { uploadUrl, key, headers: requiredHeaders } = presignBody.result.data;
    expect(key.startsWith('temp/file-import/')).toBe(true);

    // 2. Upload the CSV bytes directly to MinIO. The presigned URL binds
    //    Content-Type into the signature, so we must echo it verbatim.
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: csvBytes,
      headers: requiredHeaders,
    });
    expect(putRes.ok, `PUT to MinIO failed: ${putRes.status} ${await putRes.text()}`).toBe(true);

    // 3. Enqueue the parse-and-enrich job and wait for the worker.
    const enqueueRes = await page.request.post(`${API_BASE_URL}/trpc/fileImport.parseAndEnrich`, {
      data: {
        r2Key: key,
        fileType: 'csv',
        accountId: account.id,
        requestId: randomUUID(),
      },
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    expect(
      enqueueRes.ok(),
      `parseAndEnrich failed: ${enqueueRes.status()} ${await enqueueRes.text()}`
    ).toBe(true);
    const { jobId } = ((await enqueueRes.json()) as { result: { data: { jobId: string } } }).result
      .data;
    expect(jobId).toBeTruthy();

    const status = await waitForJob<{ transactionCount: number }>(page, jobId, {
      timeoutMs: 45_000,
    });
    expect(
      status.state,
      `file-import job ended in ${status.state}: ${status.failedReason ?? '<no reason>'}`
    ).toBe('completed');
    expect(status.returnvalue?.transactionCount).toBe(3);

    // 4. Verify the 3 imported transactions landed under the target account.
    //    Filter by `source: statement-csv` to exclude the synthetic
    //    `opening_balance` row the StatementTransactionIngester appends
    //    via `source: reconciliation-opening` to anchor the running
    //    balance — that's an ingester implementation detail, not part
    //    of the user's CSV payload.
    const txInput = encodeURIComponent(
      JSON.stringify({ accountId: account.id, source: 'statement-csv', limit: 100 })
    );
    const txRes = await page.request.get(`${API_BASE_URL}/trpc/transactions.list?input=${txInput}`);
    expect(txRes.ok()).toBe(true);
    const txBody = (await txRes.json()) as { result: { data: TransactionsListResponse } };
    expect(txBody.result.data.transactions.length).toBe(3);
  });
});
