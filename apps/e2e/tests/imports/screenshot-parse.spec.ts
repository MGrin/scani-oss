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

interface ScreenshotParseReturn {
  accountId: string | null;
  summary: { totalFiles: number; successCount: number; failureCount: number };
  results: Array<{
    r2Key: string;
    success: boolean;
    error?: string;
    data?: {
      holdings: Array<{ symbol: string; balance: string; tokenId?: string | null }>;
      overallConfidence: number;
      context?: string;
      detectedCurrency?: string;
    };
  }>;
}

/**
 * E2E coverage for the screenshot-parse flow. With `STUB_AI=1` (set by
 * `apps/e2e/scripts/run.ts` when starting the stack), `aiStubFactory`
 * is registered in front of `aiOpenAIFactory` in both the api and the
 * worker (impersonating `providerKey=ai-openai` so the AIRouter's forced
 * `provider: 'openai'` selection picks it up), returning a fixed
 * BTC + ETH + USD payload — so the actual PNG contents are irrelevant;
 * we just need a valid 1x1 PNG that survives the storage allowlist check.
 *
 * The worker stages parsed holdings in the job's `returnvalue` and does
 * NOT auto-create them. The frontend's screenshot-import flow renders a
 * picker on top of `returnvalue.results[].data.holdings` and only persists
 * via `batchOperations.createHoldingsBatch` after the user confirms. We
 * assert on `returnvalue` directly rather than `holdings.getWithDetails`
 * (which would be empty until the picker is driven), matching the actual
 * worker contract.
 */
test.describe('imports: screenshot parse (STUB_AI)', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('upload PNG → STUB_AI returns fixed BTC/ETH/USD holdings → picker payload', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-shot-${testInfo.testId}` });

    const pngPath = resolve(SPEC_DIR, '../../fixtures/data/holdings-screenshot.png');
    const pngBytes = readFileSync(pngPath);
    const pngSize = statSync(pngPath).size;

    // 1. Presigned upload URL scoped to `temp/screenshot/{userId}/...`.
    const presignRes = await page.request.post(`${API_BASE_URL}/trpc/storage.getUploadUrl`, {
      data: {
        purpose: 'screenshot',
        contentType: 'image/png',
        filename: 'holdings-screenshot.png',
        sizeBytes: pngSize,
      },
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    expect(
      presignRes.ok(),
      `presign failed: ${presignRes.status()} ${await presignRes.text()}`
    ).toBe(true);
    const presignBody = (await presignRes.json()) as { result: { data: PresignedUpload } };
    const { uploadUrl, key, headers: requiredHeaders } = presignBody.result.data;
    expect(key.startsWith('temp/screenshot/')).toBe(true);

    // 2. PUT to MinIO with the bound Content-Type.
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: pngBytes,
      headers: requiredHeaders,
    });
    expect(putRes.ok, `PUT to MinIO failed: ${putRes.status} ${await putRes.text()}`).toBe(true);

    // 3. Enqueue the parse job.
    const parseRes = await page.request.post(`${API_BASE_URL}/trpc/screenshots.parseScreenshots`, {
      data: {
        r2Keys: [key],
        accountId: account.id,
        requestId: randomUUID(),
      },
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    expect(
      parseRes.ok(),
      `parseScreenshots failed: ${parseRes.status()} ${await parseRes.text()}`
    ).toBe(true);
    const { jobId } = ((await parseRes.json()) as { result: { data: { jobId: string } } }).result
      .data;
    expect(jobId).toBeTruthy();

    const status = await waitForJob<ScreenshotParseReturn>(page, jobId, { timeoutMs: 60_000 });
    expect(
      status.state,
      `screenshot-parse job ended in ${status.state}: ${status.failedReason ?? '<no reason>'}`
    ).toBe('completed');

    const result = status.returnvalue;
    expect(result, 'returnvalue should be populated for a completed parse').toBeTruthy();
    if (!result) return;
    expect(result.accountId).toBe(account.id);
    expect(result.summary.totalFiles).toBe(1);
    expect(result.summary.successCount).toBe(1);

    // STUB_AI returns BTC + ETH + USD. The worker stages them under
    // `results[0].data.holdings`; the frontend picker renders them
    // and only persists on user confirm — we assert the stub payload
    // round-trips through the worker correctly.
    const fileResult = result.results[0];
    expect(fileResult?.success).toBe(true);
    const symbols = fileResult?.data?.holdings.map((h) => h.symbol.toUpperCase()) ?? [];
    expect(symbols).toEqual(expect.arrayContaining(['BTC', 'ETH', 'USD']));
  });
});
