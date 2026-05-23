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
      )) as typeof fetch;
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
      })) as typeof fetch;
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
      new Response(JSON.stringify({ n_tx: 3 }), { status: 200 })) as typeof fetch;
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
    }) as typeof fetch;
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
      )) as typeof fetch;
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

  test('fetchTransactions: returns [] for invalid wallet address', async () => {
    const p = new BitcoinProvider(passthroughLimiter());
    const events = await p.fetchTransactions({
      ...ctx,
      resolveCredentials: async () => ({ walletAddress: 'not-a-btc-address' }),
    } as never);
    expect(events).toEqual([]);
  });
});

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
