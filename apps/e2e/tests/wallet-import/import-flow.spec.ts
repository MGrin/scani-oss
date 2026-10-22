import { signIn } from '../../fixtures/auth';
import { expect, test } from '../../fixtures/test';
import { waitForJob } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = 'http://localhost:5173';

const WALLETS = [
  { address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', chain: 'bitcoin', symbol: 'BTC', balance: '50' },
  {
    address: 'LKDyUEtTR1HXamkiEphisSiBJu6o3ZPE34',
    chain: 'litecoin',
    symbol: 'LTC',
    balance: '2.5',
  },
] as const;

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

for (const wallet of WALLETS) {
  test.describe(`wallet-import: ${wallet.chain} address import`, () => {
    test(`paste address → enqueue import → review includes ${wallet.symbol} holding`, async ({
      page,
    }, testInfo) => {
      await signIn({ page, testInfo });

      const importRes = await page.request.post(`${API_BASE_URL}/trpc/wallet.importAddress`, {
        data: {
          address: wallet.address,
          chain: wallet.chain,
          requestId: crypto.randomUUID(),
        },
        headers: { 'content-type': 'application/json', origin: ORIGIN },
      });
      if (!importRes.ok()) {
        console.error('importAddress failed:', importRes.status(), await importRes.text());
      }
      expect(importRes.ok()).toBe(true);
      const jobId = ((await importRes.json()) as { result: { data: { jobId: string } } }).result
        .data.jobId;

      const status = await waitForJob<WalletReviewReturn>(page, jobId, { timeoutMs: 90_000 });
      expect(status.state).toBe('completed');

      const snapshots = status.returnvalue?.chains.flatMap((chain) => chain.snapshots) ?? [];
      expect(snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            balance: wallet.balance,
            tokenIdentity: expect.objectContaining({ symbol: wallet.symbol }),
          }),
        ])
      );
    });
  });
}
