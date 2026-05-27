import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';
import { waitForJob } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = 'http://localhost:5173';

// Bitcoin genesis block reward address — holds exactly 50 BTC, has
// never moved (unspendable per protocol). Stable assertion target
// since 2009. The worker auto-detects chain regardless of the `chain`
// field, so we still pass `'bitcoin'` for documentation even though
// the field is unused downstream.
const STABLE_ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const STABLE_CHAIN = 'bitcoin';

interface WalletReviewReturn {
  needsReview: boolean;
  walletLabel: string;
  walletId: string;
  address: string;
  chains: Array<{
    institutionName: string;
    chainId: number | string;
    snapshots: Array<{
      externalId: string;
      balance: string;
      tokenIdentity: { symbol?: string; name?: string };
    }>;
  }>;
  chainsDetected: number;
  candidateCount: number;
  errors: Array<{ chain?: string; error: string }>;
}

test.describe('wallet-import: stable mainnet address import', () => {
  // Depends on Bitcoin RPC reachability (mempool.space / public node).
  // Retry once on network flake.
  test.describe.configure({ retries: 1 });

  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('paste stable mainnet address → enqueue import → job completes with BTC holding', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });

    const importRes = await page.request.post(`${API_BASE_URL}/trpc/wallet.importAddress`, {
      data: {
        address: STABLE_ADDRESS,
        chain: STABLE_CHAIN,
        requestId: crypto.randomUUID(),
      },
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    if (!importRes.ok()) {
      console.error('importAddress failed:', importRes.status(), await importRes.text());
    }
    expect(importRes.ok()).toBe(true);
    const jobId = ((await importRes.json()) as { result: { data: { jobId: string } } }).result.data
      .jobId;

    const status = await waitForJob<WalletReviewReturn>(page, jobId, { timeoutMs: 90_000 });
    expect(status.state).toBe('completed');

    // Worker returns `needsReview` payload listing detected chains +
    // snapshots. We assert BTC appears somewhere in that payload —
    // either in chain metadata or in a snapshot's tokenIdentity.symbol.
    expect(JSON.stringify(status.returnvalue ?? {}).toLowerCase()).toContain('btc');
  });
});
