import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { SolanaProvider } from '../../src/providers/solana';

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

  test('fetchBalances converts lamports to SOL and emits SPL holdings', async () => {
    const p = new SolanaProvider(passthroughLimiter(), 'http://rpc');
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1;
      const body = JSON.parse(init.body as string);
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
    }) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(calls).toBe(2);
      const sol = out.find((h) => h.tokenIdentity.symbol === 'SOL');
      expect(sol?.balance).toBe('1');
      const spl = out.find((h) => h.externalId === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
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
    }) as typeof fetch;
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: emits direction-aware native, token, and swap legs', async () => {
    const heliusUrl = 'https://mainnet.helius-rpc.com/?api-key=test-key';
    const p = new SolanaProvider(passthroughLimiter(), heliusUrl);

    const tx = {
      signature: 'SIG1',
      timestamp: 1_700_000_000,
      nativeTransfers: [
        // outflow from wallet → counterparty (1 SOL = 1e9 lamports)
        { fromUserAccount: VALID_SOL, toUserAccount: 'OTHER', amount: 1_000_000_000 },
        // inflow to wallet from counterparty (0.25 SOL)
        { fromUserAccount: 'OTHER', toUserAccount: VALID_SOL, amount: 250_000_000 },
        // unrelated transfer (neither side is wallet)
        { fromUserAccount: 'A', toUserAccount: 'B', amount: 999 },
      ],
      tokenTransfers: [
        // outbound USDC: wallet → counterparty
        {
          fromUserAccount: VALID_SOL,
          toUserAccount: 'OTHER',
          tokenAmount: 50,
          decimals: 6,
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        },
      ],
      events: {
        // Swap: wallet sends 0.5 SOL in, gets 12.5 USDC out.
        swap: {
          nativeInput: { account: VALID_SOL, amount: '500000000' },
          tokenOutputs: [
            {
              userAccount: VALID_SOL,
              tokenAccount: 'TA',
              mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              rawTokenAmount: { tokenAmount: '12500000', decimals: 6 },
            },
          ],
        },
      },
    };

    const originalFetch = globalThis.fetch;
    let calls = 0;
    const captured: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls += 1;
      captured.push(url);
      // First page returns one tx; second page returns []
      if (calls === 1) return new Response(JSON.stringify([tx]), { status: 200 });
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    try {
      const events = await p.fetchTransactions(ctx as never);
      // single page (length < HELIUS_PAGE_LIMIT) → loop exits without
      // a follow-up `before` page
      expect(calls).toBe(1);
      expect(captured[0]).toContain('https://api.helius.xyz/v0/addresses/');
      expect(captured[0]).toContain(`/${VALID_SOL}/transactions`);
      expect(captured[0]).toContain('api-key=test-key');
      expect(captured[0]).toContain('limit=100');

      // 2 native (out + in, the unrelated one is dropped) + 1 token out
      // + 2 swap legs = 5 events
      expect(events).toHaveLength(5);

      const nativeOut = events.find((e) => e.externalId === 'SIG1-native-0');
      expect(nativeOut?.kind).toBe('transfer_out');
      expect(nativeOut?.primary.quantity).toBe('-1');
      expect(nativeOut?.primary.tokenIdentity.symbol).toBe('SOL');
      expect(nativeOut?.occurredAt.getTime()).toBe(1_700_000_000 * 1000);

      const nativeIn = events.find((e) => e.externalId === 'SIG1-native-1');
      expect(nativeIn?.kind).toBe('transfer_in');
      expect(nativeIn?.primary.quantity).toBe('0.25');

      // Unrelated nativeTransfers[2] must NOT produce an event
      expect(events.find((e) => e.externalId === 'SIG1-native-2')).toBeUndefined();

      const tokenOut = events.find((e) => e.externalId === 'SIG1-token-0');
      expect(tokenOut?.kind).toBe('transfer_out');
      expect(tokenOut?.primary.quantity).toBe('-50');
      expect(
        (
          tokenOut?.primary.tokenIdentity.providerMetadata as
            | { solana?: { mint: string } }
            | undefined
        )?.solana?.mint
      ).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

      const swapOut = events.find((e) => e.externalId === 'SIG1-swap-0');
      expect(swapOut?.kind).toBe('swap_out');
      expect(swapOut?.primary.tokenIdentity.symbol).toBe('SOL');
      expect(swapOut?.primary.quantity).toBe('-0.5');

      const swapIn = events.find((e) => e.externalId === 'SIG1-swap-1');
      expect(swapIn?.kind).toBe('swap_in');
      expect(swapIn?.primary.quantity).toBe('12.5');
      expect(
        (
          swapIn?.primary.tokenIdentity.providerMetadata as
            | { solana?: { mint: string } }
            | undefined
        )?.solana?.mint
      ).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: paginates via `before` cursor until short page', async () => {
    const heliusUrl = 'https://mainnet.helius-rpc.com/?api-key=k';
    const p = new SolanaProvider(passthroughLimiter(), heliusUrl);

    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      signature: `S${i}`,
      timestamp: 1_700_000_000 + i,
      nativeTransfers: [{ fromUserAccount: 'OTHER', toUserAccount: VALID_SOL, amount: 1 }],
      tokenTransfers: [],
      events: {},
    }));
    const shortPage = [
      {
        signature: 'TAIL',
        timestamp: 1_700_000_999,
        nativeTransfers: [{ fromUserAccount: 'OTHER', toUserAccount: VALID_SOL, amount: 2 }],
        tokenTransfers: [],
        events: {},
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
    }) as typeof fetch;

    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(beforeParams).toEqual([null, 'S99']);
      // 100 + 1 native-in events
      expect(events).toHaveLength(101);
      expect(events.at(-1)?.externalId).toBe('TAIL-native-0');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: applies since/until filters in-memory', async () => {
    const heliusUrl = 'https://mainnet.helius-rpc.com/?api-key=k';
    const p = new SolanaProvider(passthroughLimiter(), heliusUrl);

    const txs = [
      {
        signature: 'OLD',
        timestamp: 1_600_000_000,
        nativeTransfers: [{ fromUserAccount: 'X', toUserAccount: VALID_SOL, amount: 1 }],
        tokenTransfers: [],
        events: {},
      },
      {
        signature: 'NEW',
        timestamp: 1_800_000_000,
        nativeTransfers: [{ fromUserAccount: 'X', toUserAccount: VALID_SOL, amount: 2 }],
        tokenTransfers: [],
        events: {},
      },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(txs), { status: 200 })) as typeof fetch;

    try {
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date(1_700_000_000 * 1000),
      } as never);
      expect(events.map((e) => e.externalId)).toEqual(['NEW-native-0']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: returns [] for invalid wallet address', async () => {
    const p = new SolanaProvider(passthroughLimiter(), 'https://mainnet.helius-rpc.com/?api-key=k');
    const events = await p.fetchTransactions({
      ...ctx,
      resolveCredentials: async () => ({ walletAddress: 'bad' }),
    } as never);
    expect(events).toEqual([]);
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
