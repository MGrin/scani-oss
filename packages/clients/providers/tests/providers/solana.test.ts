import { beforeEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { SolanaProvider } from '../../src/providers/solana';
import { __resetJupiterCacheForTests } from '../../src/providers/solana/jupiter';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

// A valid base58 32-44 char string.
const VALID_SOL = '3xUu6mYXLPHdtmKb7gJj5KqgmFHA4rQfaH8XZbpLFFGT';

const ctx = {
  institutionCode: 'solana',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ walletAddress: VALID_SOL }),
};

describe('SolanaProvider', () => {
  // Per-test isolation: the Jupiter mint resolver caches results in a
  // module-level Map for production efficiency. Tests that exercise
  // fetchBalances / fetchTransactions need a fresh cache each run so
  // mocks are re-invoked.
  beforeEach(() => {
    __resetJupiterCacheForTests();
  });

  test('canFetchBalances / canValidate gate on solana', () => {
    const p = new SolanaProvider(passthroughLimiter(), 'http://rpc');
    expect(p.canFetchBalances('solana')).toBe(true);
    expect(p.canFetchBalances('bitcoin')).toBe(false);
  });

  test('isValidAddress validates base58 32-44 chars', () => {
    const p = new SolanaProvider(passthroughLimiter(), 'http://rpc');
    expect(p.isValidAddress(VALID_SOL)).toBe(true);
    expect(p.isValidAddress('0OOO')).toBe(false); // contains 0/O/I/l
    expect(p.isValidAddress('short')).toBe(false);
  });

  test('fetchBalances converts lamports to SOL and resolves SPL via Jupiter', async () => {
    const p = new SolanaProvider(passthroughLimiter(), 'http://rpc');
    const originalFetch = globalThis.fetch;
    let rpcCalls = 0;
    let jupiterCalls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();
      // Jupiter resolver: GET request, no body
      if (urlStr.includes('lite-api.jup.ag')) {
        jupiterCalls += 1;
        return new Response(
          JSON.stringify([
            {
              id: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              symbol: 'USDC',
              name: 'USD Coin',
              decimals: 6,
              isVerified: true,
            },
          ]),
          { status: 200 }
        );
      }
      rpcCalls += 1;
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.method === 'getBalance') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: 1_000_000_000 } }),
          { status: 200 }
        );
      }
      if (body.method === 'getTokenAccountsByOwner') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [
                {
                  pubkey: 'pk1',
                  account: {
                    data: {
                      parsed: {
                        info: {
                          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                          tokenAmount: { amount: '5000000', decimals: 6, uiAmount: 5 },
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      throw new Error('Unexpected RPC call');
    }) as unknown as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(rpcCalls).toBe(2);
      expect(jupiterCalls).toBe(1);
      const sol = out.find((h) => h.tokenIdentity.symbol === 'SOL');
      expect(sol?.balance).toBe('1');
      const spl = out.find((h) => h.externalId === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      // Jupiter resolves the mint to USDC instead of the legacy
      // first-8-chars-of-mint prefix.
      expect(spl?.tokenIdentity.symbol).toBe('USDC');
      expect(spl?.tokenIdentity.name).toBe('USD Coin');
      expect(spl?.balance).toBe('5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchBalances returns [] for invalid address', async () => {
    const p = new SolanaProvider(passthroughLimiter(), 'http://rpc');
    const out = await p.fetchBalances({
      ...ctx,
      resolveCredentials: async () => ({ walletAddress: 'bad' }),
    } as never);
    expect(out).toEqual([]);
  });

  test('canFetchTransactions gates on solana', () => {
    const p = new SolanaProvider(passthroughLimiter(), 'http://rpc');
    expect(p.canFetchTransactions('solana')).toBe(true);
    expect(p.canFetchTransactions('bitcoin')).toBe(false);
  });

  test('fetchTransactions: returns [] for non-Helius rpcUrl without calling fetch', async () => {
    const p = new SolanaProvider(passthroughLimiter(), 'https://api.mainnet-beta.solana.com');
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── SC-357: one net movement per token per transaction ───────────────
  //
  // Everything below reads `accountData` and nothing else. The fixtures
  // are the shapes Helius actually returned for the two production
  // wallets — see the provider header for the 312-transaction sweep that
  // produced them.

  const WSOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  function heliusOnce(page: unknown[]): () => void {
    const originalFetch = globalThis.fetch;
    let served = false;
    globalThis.fetch = (async (url: string) => {
      if (url.toString().includes('lite-api.jup.ag')) return new Response('[]', { status: 200 });
      if (served) return new Response('[]', { status: 200 });
      served = true;
      return new Response(JSON.stringify(page), { status: 200 });
    }) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  function helius(): SolanaProvider {
    return new SolanaProvider(passthroughLimiter(), 'https://mainnet.helius-rpc.com/?api-key=k');
  }

  test('fetchTransactions: a wrap/unwrap round trip books the lamports ONCE', async () => {
    // `4YzxNz4EiWCs…` in production, trimmed to the accounts that matter.
    // The wallet spent 0.500005 SOL (0.5 plus the fee) and received
    // 0.367789122 mSOL. The transfer legs said -1.0 SOL, because the
    // native leg funding the temp WSOL account and the WSOL leg leaving
    // it are the same money and WSOL is the same token identity as SOL.
    const p = helius();
    const restore = heliusOnce([
      {
        signature: 'WRAP',
        timestamp: 1_700_000_000,
        accountData: [
          { account: VALID_SOL, nativeBalanceChange: -500_005_000, tokenBalanceChanges: [] },
          {
            // The temp WSOL ATA opened and closed inside the transaction:
            // Helius reports no net change, and there is none.
            account: 'WSOLATA',
            nativeBalanceChange: 0,
            tokenBalanceChanges: [],
          },
          {
            account: 'MSOLATA',
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: VALID_SOL,
                tokenAccount: 'MSOLATA',
                mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
                rawTokenAmount: { tokenAmount: '367789122', decimals: 9 },
              },
            ],
          },
        ],
      },
    ]);
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events.map((e) => e.externalId)).toEqual([
        'WRAP-net-mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
        'WRAP-net-native',
      ]);
      const sol = events.find((e) => e.externalId === 'WRAP-net-native');
      expect(sol?.kind).toBe('transfer_out');
      expect(sol?.primary.quantity).toBe('-0.500005');
      expect(sol?.primary.tokenIdentity.symbol).toBe('SOL');
      expect(sol?.occurredAt.getTime()).toBe(1_700_000_000 * 1000);
      const msol = events.find((e) => e.kind === 'transfer_in');
      expect(msol?.primary.quantity).toBe('0.367789122');
    } finally {
      restore();
    }
  });

  test('fetchTransactions: WSOL nets against native SOL rather than beside it', async () => {
    // Wallet unwraps 2 WSOL and keeps the SOL: nothing left the wallet,
    // so nothing is booked. Netting WSOL under its own key would have
    // emitted a -2 SOL outflow and a +2 SOL inflow.
    const p = helius();
    const restore = heliusOnce([
      {
        signature: 'UNWRAP',
        timestamp: 1_700_000_000,
        accountData: [
          { account: VALID_SOL, nativeBalanceChange: 2_000_000_000, tokenBalanceChanges: [] },
          {
            account: 'WSOLATA',
            nativeBalanceChange: -2_000_000_000,
            tokenBalanceChanges: [
              {
                userAccount: VALID_SOL,
                tokenAccount: 'WSOLATA',
                mint: WSOL,
                rawTokenAmount: { tokenAmount: '-2000000000', decimals: 9 },
              },
            ],
          },
        ],
      },
    ]);
    try {
      expect(await p.fetchTransactions(ctx as never)).toEqual([]);
    } finally {
      restore();
    }
  });

  test('fetchTransactions: the fee stays inside the native net', async () => {
    // A transaction that moved nothing but cost 5000 lamports is still a
    // disposal of 0.000005 SOL. `feeQuantity` is written by the router
    // and read by no cost-basis walk, so a separate fee leg would leave
    // the ledger's total above the chain's.
    const p = helius();
    const restore = heliusOnce([
      {
        signature: 'FEEONLY',
        timestamp: 1_700_000_000,
        accountData: [{ account: VALID_SOL, nativeBalanceChange: -5_000, tokenBalanceChanges: [] }],
      },
    ]);
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events.map((e) => e.externalId)).toEqual(['FEEONLY-net-native']);
      expect(events[0]?.kind).toBe('transfer_out');
      expect(events[0]?.primary.quantity).toBe('-0.000005');
      expect(events[0]?.fee).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('fetchTransactions: ignores balance changes on accounts the wallet does not own', async () => {
    const p = helius();
    const restore = heliusOnce([
      {
        signature: 'THIRDPARTY',
        timestamp: 1_700_000_000,
        accountData: [
          { account: 'SOMEONE', nativeBalanceChange: -9_000_000_000, tokenBalanceChanges: [] },
          {
            account: 'THEIRATA',
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: 'SOMEONE',
                tokenAccount: 'THEIRATA',
                mint: USDC,
                rawTokenAmount: { tokenAmount: '1000000', decimals: 6 },
              },
            ],
          },
          { account: VALID_SOL, nativeBalanceChange: 250_000_000, tokenBalanceChanges: [] },
        ],
      },
    ]);
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events.map((e) => e.externalId)).toEqual(['THIRDPARTY-net-native']);
      expect(events[0]?.primary.quantity).toBe('0.25');
    } finally {
      restore();
    }
  });

  test('fetchTransactions: several accounts of the same mint net into one event', async () => {
    // Two USDC token accounts under the same owner, moving in opposite
    // directions. One event, carrying the difference.
    const p = helius();
    const restore = heliusOnce([
      {
        signature: 'TWOATAS',
        timestamp: 1_700_000_000,
        accountData: [
          {
            account: 'ATA1',
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: VALID_SOL,
                tokenAccount: 'ATA1',
                mint: USDC,
                rawTokenAmount: { tokenAmount: '-7000000', decimals: 6 },
              },
            ],
          },
          {
            account: 'ATA2',
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: VALID_SOL,
                tokenAccount: 'ATA2',
                mint: USDC,
                rawTokenAmount: { tokenAmount: '2500000', decimals: 6 },
              },
            ],
          },
        ],
      },
    ]);
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events).toHaveLength(1);
      expect(events[0]?.externalId).toBe(`TWOATAS-net-${USDC}`);
      expect(events[0]?.kind).toBe('transfer_out');
      expect(events[0]?.primary.quantity).toBe('-4.5');
      expect(
        (events[0]?.primary.tokenIdentity.providerMetadata as { solana?: { mint: string } })?.solana
          ?.mint
      ).toBe(USDC);
    } finally {
      restore();
    }
  });

  test('fetchTransactions: a transaction with no accountData emits nothing', async () => {
    // Legs are what this stopped trusting, so a payload carrying only
    // legs has nothing left to say. None of the 312 production
    // transactions was shaped this way.
    const p = helius();
    const restore = heliusOnce([
      {
        signature: 'LEGSONLY',
        timestamp: 1_700_000_000,
        nativeTransfers: [
          { fromUserAccount: VALID_SOL, toUserAccount: 'OTHER', amount: 1_000_000_000 },
        ],
        tokenTransfers: [
          { fromUserAccount: VALID_SOL, toUserAccount: 'OTHER', tokenAmount: 50, mint: USDC },
        ],
      },
    ]);
    try {
      expect(await p.fetchTransactions(ctx as never)).toEqual([]);
    } finally {
      restore();
    }
  });

  // SC-362 asked whether a self-transfer inside ONE signature — the
  // wallet on both sides, which produced 4 of production's same-holding
  // transfer groups — still reaches the ledger as a pair. It cannot:
  // the two sides are two accountData entries of one owner and they net
  // to zero, so the shape SC-362 describes for Kraken is already closed
  // here. Asserted directly rather than inferred from the two adjacent
  // tests, because it is the shape the ticket names.
  test('fetchTransactions: a self-transfer within one signature emits nothing (SC-362)', async () => {
    const p = helius();
    const restore = heliusOnce([
      {
        signature: 'SELFXFER',
        timestamp: 1_700_000_000,
        accountData: [
          {
            account: 'ATA1',
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: VALID_SOL,
                tokenAccount: 'ATA1',
                mint: USDC,
                rawTokenAmount: { tokenAmount: '-12500000', decimals: 6 },
              },
            ],
          },
          {
            account: 'ATA2',
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: VALID_SOL,
                tokenAccount: 'ATA2',
                mint: USDC,
                rawTokenAmount: { tokenAmount: '12500000', decimals: 6 },
              },
            ],
          },
        ],
      },
    ]);
    try {
      expect(await p.fetchTransactions(ctx as never)).toEqual([]);
    } finally {
      restore();
    }
  });

  test('fetchTransactions: a net of zero emits nothing (SC-352)', async () => {
    const p = helius();
    const restore = heliusOnce([
      {
        signature: 'SPAM',
        timestamp: 1_700_000_000,
        accountData: [{ account: VALID_SOL, nativeBalanceChange: 0, tokenBalanceChanges: [] }],
      },
    ]);
    try {
      expect(await p.fetchTransactions(ctx as never)).toEqual([]);
    } finally {
      restore();
    }
  });

  test('fetchTransactions: paginates via `before` cursor until short page', async () => {
    const p = helius();
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      signature: `S${i}`,
      timestamp: 1_700_000_000 + i,
      accountData: [{ account: VALID_SOL, nativeBalanceChange: 1, tokenBalanceChanges: [] }],
    }));
    const shortPage = [
      {
        signature: 'TAIL',
        timestamp: 1_700_000_999,
        accountData: [{ account: VALID_SOL, nativeBalanceChange: 2, tokenBalanceChanges: [] }],
      },
    ];

    const originalFetch = globalThis.fetch;
    const beforeParams: (string | null)[] = [];
    let pageIndex = 0;
    globalThis.fetch = (async (url: string) => {
      beforeParams.push(new URL(url).searchParams.get('before'));
      const body = pageIndex === 0 ? fullPage : shortPage;
      pageIndex += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(beforeParams).toEqual([null, 'S99']);
      expect(events).toHaveLength(101);
      expect(events.at(-1)?.externalId).toBe('TAIL-net-native');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // SC-360. The nightly sync passes a 30-day `since`; before this the walk
  // ran to the wallet's first ever transaction regardless, then threw the
  // result away in the filter below.
  test('fetchTransactions: `since` stops the walk once a page ends older than it', async () => {
    const p = helius();
    // Page 1 is entirely newer than the cutoff, page 2 straddles it, page 3
    // must never be requested.
    const page = (base: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        signature: `S${base + i}`,
        timestamp: base + i,
        accountData: [{ account: VALID_SOL, nativeBalanceChange: 1, tokenBalanceChanges: [] }],
      })).reverse();

    const cutoff = 1_700_000_050;
    const pages = [page(1_700_000_100), page(1_700_000_000), page(1_600_000_000)];

    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      const body = pages[requests] ?? [];
      requests += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date(cutoff * 1000),
      } as never);

      expect(requests).toBe(2);
      // The straddling page is still sifted event by event, so the boundary
      // is exact rather than page-aligned.
      expect(events).toHaveLength(150);
      for (const event of events) {
        expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(cutoff * 1000);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: without `since` the walk still runs to the end', async () => {
    const p = helius();
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      signature: `A${i}`,
      timestamp: 1_600_000_000 + i,
      accountData: [{ account: VALID_SOL, nativeBalanceChange: 1, tokenBalanceChanges: [] }],
    }));
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      const body = requests === 0 ? fullPage : [];
      requests += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(requests).toBe(2);
      expect(events).toHaveLength(100);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: applies since/until filters in-memory', async () => {
    const p = helius();
    const restore = heliusOnce([
      {
        signature: 'OLD',
        timestamp: 1_600_000_000,
        accountData: [{ account: VALID_SOL, nativeBalanceChange: 1, tokenBalanceChanges: [] }],
      },
      {
        signature: 'NEW',
        timestamp: 1_800_000_000,
        accountData: [{ account: VALID_SOL, nativeBalanceChange: 2, tokenBalanceChanges: [] }],
      },
    ]);
    try {
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date(1_700_000_000 * 1000),
      } as never);
      expect(events.map((e) => e.externalId)).toEqual(['NEW-net-native']);
    } finally {
      restore();
    }
  });

  test('fetchTransactions: returns [] for invalid wallet address', async () => {
    const p = helius();
    const events = await p.fetchTransactions({
      ...ctx,
      resolveCredentials: async () => ({ walletAddress: 'bad' }),
    } as never);
    expect(events).toEqual([]);
  });

  test('fetchTransactions: never emits a swap kind (SC-339)', async () => {
    // A swap is still recorded as two transfers. Recognising it needs a
    // partner test that only became possible once the quantities stopped
    // being doubled; until one exists, a priced disposal on a leg with no
    // reachable partner is worse than no price.
    const p = helius();
    const restore = heliusOnce([
      {
        signature: 'SWAPSIG',
        timestamp: 1_700_000_000,
        accountData: [
          { account: VALID_SOL, nativeBalanceChange: -500_005_000, tokenBalanceChanges: [] },
          {
            account: 'UATA',
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: VALID_SOL,
                tokenAccount: 'UATA',
                mint: USDC,
                rawTokenAmount: { tokenAmount: '12500000', decimals: 6 },
              },
            ],
          },
        ],
      },
    ]);
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events).toHaveLength(2);
      expect(events.some((e) => e.kind === 'swap_out' || e.kind === 'swap_in')).toBe(false);
      expect(events.some((e) => e.externalId.includes('-swap-'))).toBe(false);
    } finally {
      restore();
    }
  });
});

// Live test against Helius enhanced /transactions on devnet. Skipped
// unless SCANI_LIVE=1 AND HELIUS_API_KEY is set in the env. Hits a
// known active devnet address so the shape assertion stays stable.
test.skipIf(process.env.SCANI_LIVE !== '1' || !process.env.HELIUS_API_KEY)(
  'SolanaProvider — live Helius enhanced /transactions returns events',
  async () => {
    const apiKey = process.env.HELIUS_API_KEY ?? '';
    const url = `https://devnet.helius-rpc.com/?api-key=${apiKey}`;
    const provider = new SolanaProvider(
      { execute: async <T>(fn: () => Promise<T>) => fn() } as never,
      url
    );
    const events = await provider.fetchTransactions({
      institutionCode: 'solana',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'live', institutionId: 'live' },
      resolveCredentials: async () => ({
        walletAddress: 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUiswQrbYE19LZx',
      }),
    });
    expect(Array.isArray(events)).toBe(true);
  },
  60_000
);
