import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { GateProvider } from '../../src/providers/gate';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'gate',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
};

interface FakeResponse {
  body: unknown;
  status?: number;
}

function queueFetch(handler: (url: string) => FakeResponse): {
  restore: () => void;
  calls: string[];
} {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push(url);
    const r = handler(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

describe('GateProvider', () => {
  test('canFetchBalances gates on gate', () => {
    const p = new GateProvider(passthroughLimiter());
    expect(p.canFetchBalances('gate')).toBe(true);
    expect(p.canFetchBalances('binance')).toBe(false);
  });

  test('canFetchTransactions gates on gate', () => {
    const p = new GateProvider(passthroughLimiter());
    expect(p.canFetchTransactions('gate')).toBe(true);
    expect(p.canFetchTransactions('binance')).toBe(false);
  });

  test('fetchBalances sums available + locked, drops zeros, uppercases symbol', async () => {
    const p = new GateProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { currency: 'btc', available: '0.4', locked: '0.1' },
          { currency: 'usdt', available: '0', locked: '0' },
        ]),
        { status: 200 }
      )) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toHaveLength(1);
      expect(out[0]?.tokenIdentity.symbol).toBe('BTC');
      expect(out[0]?.balance).toBe('0.5');
      const meta = out[0]?.tokenIdentity.providerMetadata as { gate: { currency: string } };
      expect(meta.gate.currency).toBe('btc');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new GateProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'binance');
    expect(r.valid).toBe(false);
  });

  test('validateCredentials returns true on 200', async () => {
    const p = new GateProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('[]', { status: 200 })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'gate');
      expect(r.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials maps 401 to invalid', async () => {
    const p = new GateProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'gate');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('gate HTTP 401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions maps my_trades buy + sell with counter, fee, price legs', async () => {
    const p = new GateProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date('2024-01-05T00:00:00Z');

    const fetchHook = queueFetch((url) => {
      if (url.includes('/spot/accounts?') || url.endsWith('/spot/accounts')) {
        return {
          body: [{ currency: 'btc', available: '0.5', locked: '0' }],
        };
      }
      if (url.includes('/spot/accounts/ledger')) {
        return { body: [] };
      }
      if (url.includes('/spot/my_trades')) {
        const u = new URL(url);
        const pair = u.searchParams.get('currency_pair');
        if (pair === 'BTC_USDT' && !u.searchParams.get('last_id')) {
          return {
            body: [
              {
                id: '101',
                create_time: '1704067200',
                create_time_ms: '1704067200500',
                currency_pair: 'BTC_USDT',
                side: 'buy',
                amount: '0.1',
                price: '50000',
                fee: '0.5',
                fee_currency: 'USDT',
                order_id: 'o-1',
              },
              {
                id: '102',
                create_time: '1704153600',
                create_time_ms: '1704153600000',
                currency_pair: 'BTC_USDT',
                side: 'sell',
                amount: '0.05',
                price: '52000',
                fee: '0.000001',
                fee_currency: 'BTC',
                order_id: 'o-2',
              },
            ],
          };
        }
        return { body: [] };
      }
      if (url.includes('/wallet/deposits') || url.includes('/wallet/withdrawals')) {
        return { body: [] };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      const buy = events.find((e) => e.externalId === 'BTC_USDT-101');
      expect(buy?.kind).toBe('buy');
      expect(buy?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(buy?.primary.quantity).toBe('0.1');
      expect(buy?.counter?.tokenIdentity.symbol).toBe('USDT');
      expect(buy?.counter?.quantity).toBe('-5000');
      expect(buy?.fee?.tokenIdentity.symbol).toBe('USDT');
      expect(buy?.fee?.quantity).toBe('-0.5');
      expect(buy?.priceNative?.value).toBe('50000');
      expect(buy?.priceNative?.quoteIdentity.symbol).toBe('USDT');
      expect(buy?.occurredAt.getTime()).toBe(1704067200500);

      const sell = events.find((e) => e.externalId === 'BTC_USDT-102');
      expect(sell?.kind).toBe('sell');
      expect(sell?.primary.quantity).toBe('-0.05');
      expect(sell?.counter?.quantity).toBe('2600');
      expect(sell?.fee?.tokenIdentity.symbol).toBe('BTC');
      expect(sell?.fee?.quantity).toBe('-0.000001');
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions emits fee + transfer events from /spot/accounts/ledger', async () => {
    const p = new GateProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date('2024-01-05T00:00:00Z');

    const fetchHook = queueFetch((url) => {
      if (url.endsWith('/spot/accounts') || url.includes('/spot/accounts?')) {
        return { body: [{ currency: 'usdt', available: '100', locked: '0' }] };
      }
      if (url.includes('/spot/accounts/ledger')) {
        const u = new URL(url);
        if (u.searchParams.get('page') === '1') {
          return {
            body: [
              {
                id: 'L-1',
                time: '1704067200.123',
                currency: 'USDT',
                change: '-0.25',
                balance: '99.75',
                type: 'fee',
                text: 'maker fee for trade #o-1',
              },
              {
                id: 'L-2',
                time: '1704153600',
                currency: 'USDT',
                change: '-50',
                balance: '49.75',
                type: 'transfer',
                text: 'sub-account transfer',
              },
              {
                id: 'L-3',
                time: '1704153700',
                currency: 'USDT',
                change: '0.1',
                balance: '49.85',
                type: 'trade',
                text: 'trade leg, skipped — pair info comes from my_trades',
              },
            ],
          };
        }
        return { body: [] };
      }
      if (url.includes('/spot/my_trades')) return { body: [] };
      if (url.includes('/wallet/deposits') || url.includes('/wallet/withdrawals')) {
        return { body: [] };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      const fee = events.find((e) => e.externalId === 'ledger-L-1');
      expect(fee?.kind).toBe('fee');
      expect(fee?.primary.tokenIdentity.symbol).toBe('USDT');
      expect(fee?.primary.quantity).toBe('-0.25');
      expect(fee?.occurredAt.getTime()).toBe(1704067200123);

      const transfer = events.find((e) => e.externalId === 'ledger-L-2');
      expect(transfer?.kind).toBe('unknown');
      expect(transfer?.primary.quantity).toBe('-50');

      // Trade-typed ledger row is skipped — no synthetic event.
      expect(events.find((e) => e.externalId === 'ledger-L-3')).toBeUndefined();
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions maps deposits + withdrawals from /wallet endpoints with txid', async () => {
    const p = new GateProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date('2024-01-05T00:00:00Z');

    const fetchHook = queueFetch((url) => {
      if (url.endsWith('/spot/accounts') || url.includes('/spot/accounts?')) {
        return { body: [{ currency: 'btc', available: '0.5', locked: '0' }] };
      }
      if (url.includes('/spot/accounts/ledger')) return { body: [] };
      if (url.includes('/spot/my_trades')) return { body: [] };
      if (url.includes('/wallet/deposits')) {
        const u = new URL(url);
        if (u.searchParams.get('offset') === '0') {
          return {
            body: [
              {
                id: 'D-1',
                txid: '0xabc',
                amount: '0.5',
                currency: 'BTC',
                chain: 'BTC',
                timestamp: '1704067200',
                status: 'DONE',
              },
            ],
          };
        }
        return { body: [] };
      }
      if (url.includes('/wallet/withdrawals')) {
        const u = new URL(url);
        if (u.searchParams.get('offset') === '0') {
          return {
            body: [
              {
                id: 'W-1',
                txid: '0xdef',
                amount: '0.05',
                currency: 'BTC',
                chain: 'BTC',
                fee: '0.0005',
                timestamp: '1704153600',
                status: 'DONE',
              },
            ],
          };
        }
        return { body: [] };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      const dep = events.find((e) => e.kind === 'deposit');
      expect(dep?.externalId).toBe('dep-BTC-0xabc');
      expect(dep?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(dep?.primary.quantity).toBe('0.5');

      const wd = events.find((e) => e.kind === 'withdraw');
      expect(wd?.externalId).toBe('wd-BTC-0xdef');
      expect(wd?.primary.quantity).toBe('-0.05');
      expect(wd?.fee?.tokenIdentity.symbol).toBe('BTC');
      expect(wd?.fee?.quantity).toBe('-0.0005');
    } finally {
      fetchHook.restore();
    }
  });

  test('paginateMyTrades walks the last_id cursor', async () => {
    const p = new GateProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date('2024-01-05T00:00:00Z');

    let tradesPage = 0;
    const fetchHook = queueFetch((url) => {
      if (url.endsWith('/spot/accounts') || url.includes('/spot/accounts?')) {
        return { body: [{ currency: 'btc', available: '0.5', locked: '0' }] };
      }
      if (url.includes('/spot/accounts/ledger')) return { body: [] };
      if (url.includes('/spot/my_trades')) {
        const u = new URL(url);
        if (u.searchParams.get('currency_pair') !== 'BTC_USDT') return { body: [] };
        tradesPage += 1;
        if (tradesPage === 1) {
          // Fill an entire page so the loop tries another cursor advance.
          const rows = Array.from({ length: 1000 }, (_, i) => ({
            id: String(1000 + i),
            create_time: '1704067200',
            create_time_ms: '1704067200000',
            currency_pair: 'BTC_USDT',
            side: 'buy' as const,
            amount: '0.001',
            price: '50000',
          }));
          return { body: rows };
        }
        return { body: [] };
      }
      if (url.includes('/wallet/deposits') || url.includes('/wallet/withdrawals')) {
        return { body: [] };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      // 2 my_trades calls (page 1 full of 1000 rows, page 2 empty terminator).
      expect(tradesPage).toBe(2);
      // 1000 buy events from BTC_USDT.
      expect(events.filter((e) => e.kind === 'buy')).toHaveLength(1000);
    } finally {
      fetchHook.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Live test against production — opt-in via SCANI_LIVE=1.
// Gate.io spot has no public sandbox; live tests require SCANI_GATE_API_KEY
// + SCANI_GATE_API_SECRET against production with READ-ONLY keys. Use a
// throwaway account with a small balance — production credentials see real
// funds.
// ---------------------------------------------------------------------------
const liveDescribe =
  process.env.SCANI_LIVE === '1' &&
  process.env.SCANI_GATE_API_KEY &&
  process.env.SCANI_GATE_API_SECRET
    ? describe
    : describe.skip;

liveDescribe('GateProvider [live production / read-only key]', () => {
  test('fetchTransactions hits api.gateio.ws without HTTP error', async () => {
    const p = new GateProvider(passthroughLimiter());
    const liveCtx = {
      ...ctx,
      resolveCredentials: async () => ({
        apiKey: process.env.SCANI_GATE_API_KEY!,
        apiSecret: process.env.SCANI_GATE_API_SECRET!,
      }),
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      until: new Date(),
    };
    const events = await p.fetchTransactions(liveCtx as never);
    expect(Array.isArray(events)).toBe(true);
  });
});
