import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { BitcoinProvider } from '../../src/providers/bitcoin';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const WALLET = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

const ctx = {
  institutionCode: 'bitcoin',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({
    walletAddress: WALLET,
  }),
};

describe('BitcoinProvider', () => {
  test('canFetchBalances / canFetchTransactions / canValidate gate on bitcoin', () => {
    const p = new BitcoinProvider(passthroughLimiter());
    expect(p.canFetchBalances('bitcoin')).toBe(true);
    expect(p.canFetchBalances('ethereum')).toBe(false);
    expect(p.canFetchTransactions('bitcoin')).toBe(true);
    expect(p.canFetchTransactions('ethereum')).toBe(false);
    expect(p.canValidate('bitcoin')).toBe(true);
  });

  test('isValidAddress accepts P2PKH, P2SH, Bech32', () => {
    const p = new BitcoinProvider(passthroughLimiter());
    expect(p.isValidAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
    expect(p.isValidAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
    expect(p.isValidAddress('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')).toBe(true);
    expect(p.isValidAddress('not-a-btc-address')).toBe(false);
  });

  test('fetchBalances converts satoshis to BTC and emits a single holding', async () => {
    const p = new BitcoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          address: 'x',
          final_balance: 50_000_000, // 0.5 BTC
          n_tx: 10,
          total_received: 0,
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toHaveLength(1);
      expect(out[0]?.tokenIdentity.symbol).toBe('BTC');
      expect(out[0]?.balance).toBe('0.5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchBalances returns empty when balance is zero', async () => {
    const p = new BitcoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ address: 'x', final_balance: 0, n_tx: 0, total_received: 0 }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('hasActivity returns true when n_tx > 0', async () => {
    const p = new BitcoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ n_tx: 3 }), { status: 200 })) as unknown as typeof fetch;
    try {
      const result = await p.hasActivity('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'bitcoin', {
        baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      });
      expect(result).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: net-delta math + sign + single page stop', async () => {
    const p = new BitcoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      calls += 1;
      // Two txs: one inflow (wallet receives 25_000_000 sat = 0.25 BTC),
      // one outflow (wallet sends 60_000_000 sat from inputs, gets back
      // 10_000_000 sat as change → net -0.5 BTC).
      const body = {
        address: WALLET,
        final_balance: 0,
        n_tx: 2,
        total_received: 0,
        txs: [
          {
            hash: 'tx-inflow',
            time: 1_700_000_000,
            inputs: [{ prev_out: { addr: 'someone-else', value: 30_000_000 } }],
            out: [
              { addr: WALLET, value: 25_000_000 },
              { addr: 'someone-else-change', value: 4_990_000 },
            ],
          },
          {
            hash: 'tx-outflow',
            time: 1_700_000_500,
            inputs: [{ prev_out: { addr: WALLET, value: 60_000_000 } }],
            out: [
              { addr: 'recipient', value: 49_000_000 },
              { addr: WALLET, value: 10_000_000 },
            ],
          },
        ],
      };
      expect(url).toContain('limit=50');
      expect(url).toContain('offset=0');
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(calls).toBe(1);
      expect(events).toHaveLength(2);

      const inflow = events.find((e) => e.externalId === 'tx-inflow');
      expect(inflow?.kind).toBe('transfer_in');
      expect(inflow?.primary.quantity).toBe('0.25');
      expect(inflow?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(inflow?.primary.tokenIdentity.decimals).toBe(8);
      expect(inflow?.occurredAt.getTime()).toBe(1_700_000_000 * 1000);

      const outflow = events.find((e) => e.externalId === 'tx-outflow');
      expect(outflow?.kind).toBe('transfer_out');
      expect(outflow?.primary.quantity).toBe('-0.5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // `holding_tx_dedup` is UNIQUE per (holding, source, externalId), and a
  // Bitcoin tx can pay the same wallet several times. Summing them into
  // one net delta is what keeps the key unique — emitting one event per
  // output would put several rows on one key and the ledger would keep
  // whichever landed last (SC-349).
  test('fetchTransactions: several outputs to the wallet are one event on one key', async () => {
    const p = new BitcoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          address: WALLET,
          final_balance: 0,
          n_tx: 1,
          total_received: 0,
          txs: [
            {
              hash: 'tx-multi-output',
              time: 1_700_000_000,
              inputs: [{ prev_out: { addr: 'someone-else', value: 30_000_000 } }],
              out: [
                { addr: WALLET, value: 10_000_000 },
                { addr: WALLET, value: 5_000_000 },
                { addr: 'someone-else-change', value: 14_990_000 },
              ],
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events).toHaveLength(1);
      expect(events[0]?.externalId).toBe('tx-multi-output');
      expect(events[0]?.primary.quantity).toBe('0.15');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: applies since/until filters in-memory', async () => {
    const p = new BitcoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          address: WALLET,
          final_balance: 0,
          n_tx: 2,
          total_received: 0,
          txs: [
            {
              hash: 'old',
              time: 1_600_000_000,
              inputs: [],
              out: [{ addr: WALLET, value: 1_000_000 }],
            },
            {
              hash: 'new',
              time: 1_800_000_000,
              inputs: [],
              out: [{ addr: WALLET, value: 2_000_000 }],
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date(1_700_000_000 * 1000),
      } as never);
      expect(events.map((e) => e.externalId)).toEqual(['new']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // SC-364. blockchain.info pages newest-first, so a page that ends
  // older than `since` means every later page is older still. Without
  // the break the nightly 30-day sync re-walked the whole history to
  // throw all of it away in the filter.
  test('fetchTransactions: since stops the walk at the first page that ends older', async () => {
    const p = new BitcoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    const offsets: string[] = [];
    // Page 0 is full and ends at t=1_800_000_000 (newer than the cutoff),
    // so the walk continues. Page 1 is full but ends older, so it stops
    // without asking for page 2.
    const page = (startTime: number, step: number) => ({
      address: WALLET,
      final_balance: 0,
      n_tx: 150,
      total_received: 0,
      txs: Array.from({ length: 50 }, (_, i) => ({
        hash: `tx-${startTime}-${i}`,
        time: startTime - i * step,
        inputs: [],
        out: [{ addr: WALLET, value: 1_000_000 }],
      })),
    });
    globalThis.fetch = (async (url: string) => {
      const offset = new URL(url).searchParams.get('offset') ?? '';
      offsets.push(offset);
      const body = offset === '0' ? page(1_900_000_000, 2_000_000) : page(1_700_000_000, 2_000_000);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date(1_750_000_000 * 1000),
      } as never);
      expect(offsets).toEqual(['0', '50']);
      // The straddling page is still filtered per-event, so nothing older
      // than the cutoff survives.
      expect(events.every((e) => e.occurredAt.getTime() >= 1_750_000_000 * 1000)).toBe(true);
      expect(events.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: without since the walk reads the full history', async () => {
    const p = new BitcoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const full = calls < 3;
      return new Response(
        JSON.stringify({
          address: WALLET,
          final_balance: 0,
          n_tx: 120,
          total_received: 0,
          txs: Array.from({ length: full ? 50 : 20 }, (_, i) => ({
            hash: `tx-${calls}-${i}`,
            time: 1_900_000_000 - calls * 1_000_000 - i,
            inputs: [],
            out: [{ addr: WALLET, value: 1_000_000 }],
          })),
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(calls).toBe(3);
      expect(events).toHaveLength(120);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: returns [] for invalid wallet address', async () => {
    const p = new BitcoinProvider(passthroughLimiter());
    const events = await p.fetchTransactions({
      ...ctx,
      resolveCredentials: async () => ({ walletAddress: 'not-a-btc-address' }),
    } as never);
    expect(events).toEqual([]);
  });
});

// The `since` early-break rests on two upstream properties no offline
// test can hold blockchain.info to: pages descend by block height, and
// `time` inversions between adjacent rows stay inside the two-hour
// consensus bound the break's margin is sized for. Asserting
// strict time ordering here FAILED on 2026-08-17 (one inversion of
// 1h48m in a 50-tx page), which is why the margin exists at all.
// Opt-in via SCANI_LIVE=1.
test.skipIf(process.env.SCANI_LIVE !== '1')(
  'BitcoinProvider — live /rawaddr descends by block height with bounded time skew',
  async () => {
    const response = await fetch(
      'https://blockchain.info/rawaddr/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa?limit=50&offset=0'
    );
    expect(response.ok).toBe(true);
    const data = (await response.json()) as {
      txs: Array<{ time: number; block_height?: number | null }>;
    };
    expect(data.txs.length).toBeGreaterThan(1);
    const confirmed = data.txs.filter((tx) => typeof tx.block_height === 'number');
    for (let i = 1; i < confirmed.length; i++) {
      expect(confirmed[i]?.block_height as number).toBeLessThanOrEqual(
        confirmed[i - 1]?.block_height as number
      );
    }
    for (let i = 1; i < data.txs.length; i++) {
      const forwardJump = (data.txs[i]?.time as number) - (data.txs[i - 1]?.time as number);
      expect(forwardJump).toBeLessThan(2 * 60 * 60);
    }
  },
  60_000
);

// Live test against the public blockchain.info /rawaddr endpoint.
// Hits the genesis address (50 BTC coinbase reward, single tx) so the
// shape assertion is stable. Opt-in via SCANI_LIVE=1.
test.skipIf(process.env.SCANI_LIVE !== '1')(
  'BitcoinProvider — live blockchain.info /rawaddr returns events',
  async () => {
    const provider = new BitcoinProvider(passthroughLimiter());
    const events = await provider.fetchTransactions({
      institutionCode: 'bitcoin',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'live', institutionId: 'live' },
      resolveCredentials: async () => ({
        walletAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      }),
    });
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.primary.tokenIdentity.symbol).toBe('BTC');
      expect(['transfer_in', 'transfer_out']).toContain(e.kind);
    }
  },
  60_000
);
