import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { CoinbaseProvider } from '../../src/providers/coinbase';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'coinbase',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
};

describe('CoinbaseProvider', () => {
  test('canFetchBalances gates on coinbase', () => {
    const p = new CoinbaseProvider(passthroughLimiter());
    expect(p.canFetchBalances('coinbase')).toBe(true);
    expect(p.canFetchBalances('binance')).toBe(false);
  });

  test('canFetchTransactions gates on coinbase', () => {
    const p = new CoinbaseProvider(passthroughLimiter());
    expect(p.canFetchTransactions('coinbase')).toBe(true);
    expect(p.canFetchTransactions('binance')).toBe(false);
  });

  test('declares transactions capability', () => {
    const p = new CoinbaseProvider(passthroughLimiter());
    expect(p.capabilities).toContain('transactions');
    expect(p.capabilities).toContain('current-balances');
    expect(p.capabilities).toContain('credential-validator');
  });

  test('fetchBalances merges multi-wallet same-currency entries, drops zeros, paginates', async () => {
    const p = new CoinbaseProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'a',
                name: 'BTC Wallet',
                type: 'wallet',
                currency: { code: 'BTC', name: 'Bitcoin' },
                balance: { amount: '0.5', currency: 'BTC' },
              },
              {
                id: 'b',
                name: 'BTC Vault',
                type: 'vault',
                currency: { code: 'BTC', name: 'Bitcoin' },
                balance: { amount: '0.25', currency: 'BTC' },
              },
              {
                id: 'c',
                name: 'USDC',
                type: 'wallet',
                currency: { code: 'USDC', name: 'USD Coin' },
                balance: { amount: '0', currency: 'USDC' },
              },
            ],
            pagination: { next_uri: '/v2/accounts?limit=100&starting_after=c' },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ data: [], pagination: { next_uri: null } }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toHaveLength(1);
      expect(out[0]?.tokenIdentity.symbol).toBe('BTC');
      expect(out[0]?.balance).toBe('0.75');
      expect(callCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new CoinbaseProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'binance');
    expect(r.valid).toBe(false);
  });

  test('validateCredentials returns true on 200', async () => {
    const p = new CoinbaseProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'coinbase');
      expect(r.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials maps 401 to invalid', async () => {
    const p = new CoinbaseProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'coinbase');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('coinbase HTTP 401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions paginates via next_uri across accounts', async () => {
    const p = new CoinbaseProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];

    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      // Accounts page (single page).
      if (url.includes('/v2/accounts?')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'acct-btc',
                name: 'BTC',
                type: 'wallet',
                currency: { code: 'BTC', name: 'Bitcoin' },
                balance: { amount: '0', currency: 'BTC' },
              },
              {
                id: 'acct-eth',
                name: 'ETH',
                type: 'wallet',
                currency: { code: 'ETH', name: 'Ether' },
                balance: { amount: '0', currency: 'ETH' },
              },
            ],
            pagination: { next_uri: null },
          }),
          { status: 200 }
        );
      }

      // BTC account: page 2 (matched first since page 1's URL is a prefix).
      if (url.includes('/v2/accounts/acct-btc/transactions?limit=100&starting_after=tx-btc-1')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'tx-btc-2',
                type: 'sell',
                status: 'completed',
                amount: { amount: '-0.1', currency: 'BTC' },
                native_amount: { amount: '-4000', currency: 'USD' },
                created_at: '2025-01-02T00:00:00Z',
              },
            ],
            pagination: { next_uri: null },
          }),
          { status: 200 }
        );
      }
      if (url.includes('/v2/accounts/acct-btc/transactions?limit=100')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'tx-btc-1',
                type: 'buy',
                status: 'completed',
                amount: { amount: '0.5', currency: 'BTC' },
                native_amount: { amount: '20000', currency: 'USD' },
                created_at: '2025-01-01T00:00:00Z',
              },
            ],
            pagination: {
              next_uri: '/v2/accounts/acct-btc/transactions?limit=100&starting_after=tx-btc-1',
            },
          }),
          { status: 200 }
        );
      }

      // ETH account: single page.
      if (url.includes('/v2/accounts/acct-eth/transactions?limit=100')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'tx-eth-1',
                type: 'fiat_deposit',
                status: 'completed',
                amount: { amount: '1', currency: 'ETH' },
                native_amount: { amount: '2500', currency: 'USD' },
                created_at: '2025-01-03T00:00:00Z',
              },
            ],
            pagination: { next_uri: null },
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      const out = await p.fetchTransactions(ctx as never);
      expect(out).toHaveLength(3);
      const ids = out.map((e) => e.externalId).sort();
      expect(ids).toEqual(['tx-btc-1', 'tx-btc-2', 'tx-eth-1']);

      // Pagination math: 1 accounts call + 2 BTC tx pages + 1 ETH tx page = 4.
      expect(calls).toHaveLength(4);
      // Second BTC call must have followed the server-provided next_uri.
      expect(calls.some((u) => u.includes('starting_after=tx-btc-1'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions maps types to ledger kinds and enforces sign', async () => {
    const p = new CoinbaseProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;

    const txs = [
      {
        id: 'buy-1',
        type: 'buy',
        status: 'completed',
        amount: { amount: '0.5', currency: 'BTC' },
        native_amount: { amount: '20000', currency: 'USD' },
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'sell-1',
        type: 'sell',
        status: 'completed',
        // Coinbase already returns sells as negative; pass-through.
        amount: { amount: '-0.1', currency: 'BTC' },
        native_amount: { amount: '-4000', currency: 'USD' },
        created_at: '2025-01-02T00:00:00Z',
      },
      {
        id: 'sell-positive',
        type: 'sell',
        status: 'completed',
        // Defensive: if the wire ever sends positive on a sell,
        // enforceSign must flip it negative.
        amount: { amount: '0.2', currency: 'BTC' },
        native_amount: { amount: '8000', currency: 'USD' },
        created_at: '2025-01-02T01:00:00Z',
      },
      {
        id: 'fiat-dep',
        type: 'fiat_deposit',
        status: 'completed',
        amount: { amount: '1000', currency: 'USD' },
        native_amount: { amount: '1000', currency: 'USD' },
        created_at: '2025-01-03T00:00:00Z',
      },
      {
        id: 'exch-dep',
        type: 'exchange_deposit',
        status: 'completed',
        amount: { amount: '1', currency: 'BTC' },
        native_amount: { amount: '40000', currency: 'USD' },
        created_at: '2025-01-04T00:00:00Z',
      },
      {
        id: 'pro-dep',
        type: 'pro_deposit',
        status: 'completed',
        amount: { amount: '2', currency: 'ETH' },
        native_amount: { amount: '5000', currency: 'USD' },
        created_at: '2025-01-05T00:00:00Z',
      },
      {
        id: 'fiat-wd',
        type: 'fiat_withdrawal',
        status: 'completed',
        amount: { amount: '-500', currency: 'USD' },
        native_amount: { amount: '-500', currency: 'USD' },
        created_at: '2025-01-06T00:00:00Z',
      },
      {
        id: 'exch-wd',
        type: 'exchange_withdrawal',
        status: 'completed',
        amount: { amount: '-0.5', currency: 'BTC' },
        native_amount: { amount: '-20000', currency: 'USD' },
        created_at: '2025-01-07T00:00:00Z',
      },
      {
        id: 'pro-wd',
        type: 'pro_withdrawal',
        status: 'completed',
        amount: { amount: '-1', currency: 'ETH' },
        native_amount: { amount: '-2500', currency: 'USD' },
        created_at: '2025-01-08T00:00:00Z',
      },
      {
        id: 'send-out',
        type: 'send',
        status: 'completed',
        amount: { amount: '-0.05', currency: 'BTC' },
        native_amount: { amount: '-2000', currency: 'USD' },
        created_at: '2025-01-09T00:00:00Z',
      },
      {
        id: 'send-in',
        type: 'send',
        status: 'completed',
        amount: { amount: '0.03', currency: 'BTC' },
        native_amount: { amount: '1200', currency: 'USD' },
        created_at: '2025-01-10T00:00:00Z',
      },
      {
        id: 'staking',
        type: 'staking_reward',
        status: 'completed',
        amount: { amount: '0.01', currency: 'ETH' },
        native_amount: { amount: '25', currency: 'USD' },
        created_at: '2025-01-11T00:00:00Z',
      },
      {
        id: 'interest-1',
        type: 'interest',
        status: 'completed',
        amount: { amount: '0.5', currency: 'USDC' },
        native_amount: { amount: '0.5', currency: 'USD' },
        created_at: '2025-01-12T00:00:00Z',
      },
      {
        id: 'pending-skip',
        type: 'buy',
        status: 'pending',
        amount: { amount: '99', currency: 'BTC' },
        native_amount: { amount: '99', currency: 'USD' },
        created_at: '2025-01-13T00:00:00Z',
      },
      {
        id: 'unknown-skip',
        type: 'mystery_event',
        status: 'completed',
        amount: { amount: '1', currency: 'BTC' },
        native_amount: { amount: '1', currency: 'USD' },
        created_at: '2025-01-14T00:00:00Z',
      },
    ];

    globalThis.fetch = (async (url: string) => {
      if (url.includes('/v2/accounts?')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'acct-1',
                name: 'BTC',
                type: 'wallet',
                currency: { code: 'BTC', name: 'Bitcoin' },
                balance: { amount: '0', currency: 'BTC' },
              },
            ],
            pagination: { next_uri: null },
          }),
          { status: 200 }
        );
      }
      if (url.includes('/v2/accounts/acct-1/transactions')) {
        return new Response(JSON.stringify({ data: txs, pagination: { next_uri: null } }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      const out = await p.fetchTransactions(ctx as never);
      const byId = new Map(out.map((e) => [e.externalId, e]));

      // Pending and unknown-type rows must be filtered out.
      expect(byId.has('pending-skip')).toBe(false);
      expect(byId.has('unknown-skip')).toBe(false);
      expect(out).toHaveLength(13);

      expect(byId.get('buy-1')?.kind).toBe('buy');
      expect(byId.get('buy-1')?.primary.quantity).toBe('0.5');

      expect(byId.get('sell-1')?.kind).toBe('sell');
      expect(byId.get('sell-1')?.primary.quantity).toBe('-0.1');

      // enforceSign must flip a positive raw value when kind is 'sell'.
      expect(byId.get('sell-positive')?.kind).toBe('sell');
      expect(byId.get('sell-positive')?.primary.quantity).toBe('-0.2');

      expect(byId.get('fiat-dep')?.kind).toBe('deposit');
      expect(byId.get('exch-dep')?.kind).toBe('deposit');
      expect(byId.get('pro-dep')?.kind).toBe('deposit');
      expect(byId.get('fiat-dep')?.primary.quantity).toBe('1000');

      expect(byId.get('fiat-wd')?.kind).toBe('withdraw');
      expect(byId.get('exch-wd')?.kind).toBe('withdraw');
      expect(byId.get('pro-wd')?.kind).toBe('withdraw');
      expect(byId.get('fiat-wd')?.primary.quantity).toBe('-500');

      expect(byId.get('send-out')?.kind).toBe('transfer_out');
      expect(byId.get('send-out')?.primary.quantity).toBe('-0.05');

      expect(byId.get('send-in')?.kind).toBe('transfer_in');
      expect(byId.get('send-in')?.primary.quantity).toBe('0.03');

      expect(byId.get('staking')?.kind).toBe('reward');
      expect(byId.get('staking')?.primary.quantity).toBe('0.01');

      expect(byId.get('interest-1')?.kind).toBe('interest');
      expect(byId.get('interest-1')?.primary.quantity).toBe('0.5');

      // Token identity uses uppercase symbol with provider metadata namespace.
      expect(byId.get('buy-1')?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(byId.get('staking')?.primary.tokenIdentity.symbol).toBe('ETH');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions filters by since/until window', async () => {
    const p = new CoinbaseProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: string) => {
      if (url.includes('/v2/accounts?')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'acct-1',
                name: 'BTC',
                type: 'wallet',
                currency: { code: 'BTC', name: 'Bitcoin' },
                balance: { amount: '0', currency: 'BTC' },
              },
            ],
            pagination: { next_uri: null },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'before',
              type: 'buy',
              status: 'completed',
              amount: { amount: '1', currency: 'BTC' },
              native_amount: { amount: '40000', currency: 'USD' },
              created_at: '2024-12-31T00:00:00Z',
            },
            {
              id: 'inside',
              type: 'buy',
              status: 'completed',
              amount: { amount: '1', currency: 'BTC' },
              native_amount: { amount: '40000', currency: 'USD' },
              created_at: '2025-01-15T00:00:00Z',
            },
            {
              id: 'after',
              type: 'buy',
              status: 'completed',
              amount: { amount: '1', currency: 'BTC' },
              native_amount: { amount: '40000', currency: 'USD' },
              created_at: '2025-02-15T00:00:00Z',
            },
          ],
          pagination: { next_uri: null },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    try {
      const out = await p.fetchTransactions({
        ...ctx,
        since: new Date('2025-01-01T00:00:00Z'),
        until: new Date('2025-02-01T00:00:00Z'),
      } as never);
      expect(out.map((e) => e.externalId)).toEqual(['inside']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
