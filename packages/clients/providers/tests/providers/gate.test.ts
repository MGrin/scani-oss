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
  }) as unknown as typeof fetch;
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
      )) as unknown as typeof fetch;
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
    globalThis.fetch = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
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
    globalThis.fetch = (async () =>
      new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;
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

  // SC-1302. Gate caps `from`/`to` at 30 days on all four history endpoints
  // — "Record query time range cannot exceed 30 days" for the ledger and the
  // two wallet walks, "The range not allowed to exceed 30 days" for
  // my_trades — and a `since`-less run substitutes a FIVE-YEAR look-back.
  //
  // This is the SC-171 shape rather than the loud SC-166 one: every walk in
  // `fetchTransactions` is wrapped in `.catch(() => [])`, so Gate's rejection
  // of the five-year span never surfaces as a failure. It reads as an account
  // with no history, and the import completes green having written nothing.
  //
  // The assertion is on EVERY window sent, not on a happy path, and the
  // length check above it is the control — a run that sent no ranged request
  // at all would satisfy every span assertion vacuously.
  test('a since-less run asks for no window Gate will reject', async () => {
    const p = new GateProvider(passthroughLimiter());
    const day = 24 * 60 * 60;
    const RANGED = [
      '/spot/accounts/ledger',
      '/spot/my_trades',
      '/wallet/deposits',
      '/wallet/withdrawals',
    ];
    const spans: Array<{ path: string; from: number; to: number }> = [];

    const fetchHook = queueFetch((url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/spot/accounts')) {
        return { body: [{ currency: 'btc', available: '0.5', locked: '0' }] };
      }
      spans.push({
        path: u.pathname,
        from: Number(u.searchParams.get('from')),
        to: Number(u.searchParams.get('to')),
      });
      return { body: [] };
    });

    const before = Math.floor(Date.now() / 1000);
    try {
      await p.fetchTransactions({ ...ctx } as never);
    } finally {
      fetchHook.restore();
    }
    const after = Math.floor(Date.now() / 1000);

    expect(spans.length).toBeGreaterThan(0);
    for (const endpoint of RANGED) {
      expect(spans.some((s) => s.path.endsWith(endpoint))).toBe(true);
    }

    const tooWide = spans
      .filter((s) => s.to - s.from > 30 * day)
      .map((s) => `${s.path} spans ${((s.to - s.from) / day).toFixed(1)}d`);
    expect(tooWide).toEqual([]);

    // Splitting must not shorten the reach: the windows still cover the whole
    // five years the single request used to ask for, ending at `until`.
    const minFrom = Math.min(...spans.map((s) => s.from));
    const maxTo = Math.max(...spans.map((s) => s.to));
    expect(maxTo).toBeGreaterThanOrEqual(before - 1);
    expect(maxTo).toBeLessThanOrEqual(after + 1);
    expect(maxTo - minFrom).toBeGreaterThanOrEqual(5 * 365 * day - 1);
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

/**
 * SC-1480 / SC-1481. Trade pairs used to come from CURRENT balances only, so
 * an asset bought and sold to zero never had its trades asked for; and every
 * sub-walk was `.catch(() => [])` with nothing said.
 */
describe('GateProvider.fetchTransactions — exited assets and failed walks', () => {
  const since = new Date('2023-11-01T00:00:00Z');
  const until = new Date('2023-11-20T00:00:00Z');
  const ethSell = {
    id: '7',
    create_time: '1700000000',
    currency_pair: 'ETH_USDT',
    side: 'sell',
    amount: '1',
    price: '2000',
  };

  function mockGate(ledger: () => FakeResponse) {
    const pairs: string[] = [];
    const hook = queueFetch((url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/spot/accounts/ledger')) return ledger();
      if (u.pathname.endsWith('/spot/accounts')) {
        return { body: [{ currency: 'USDT', available: '2000', locked: '0' }] };
      }
      if (u.pathname.endsWith('/wallet/deposits')) return { body: [] };
      if (u.pathname.endsWith('/wallet/withdrawals')) return { body: [] };
      if (u.pathname.endsWith('/spot/my_trades')) {
        const pair = u.searchParams.get('currency_pair') ?? '';
        pairs.push(pair);
        if (pair === 'ETH_USDT') return { body: u.searchParams.get('last_id') ? [] : [ethSell] };
        // Every other candidate is a pair Gate does not list.
        return { status: 400, body: { label: 'INVALID_CURRENCY_PAIR', message: pair } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    return { hook, pairs };
  }

  test('an asset seen only in the ledger has its trades fetched, and absent pairs retract nothing', async () => {
    const { hook, pairs } = mockGate(() => ({
      body: [
        {
          id: 'L-9',
          time: '1700000000',
          currency: 'ETH',
          change: '-1',
          balance: '0',
          type: 'trade',
        },
      ],
    }));
    const retractions: unknown[] = [];
    try {
      const events = await new GateProvider(passthroughLimiter()).fetchTransactions({
        ...ctx,
        since,
        until,
        retractHistoryClaim: (r: unknown) => retractions.push(r),
      } as never);
      expect(pairs).toContain('ETH_USDT');
      expect(events.map((e) => e.externalId)).toContain('ETH_USDT-7');
      expect(retractions).toEqual([]);
    } finally {
      hook.restore();
    }
  });

  test('a failed ledger walk retracts the history claim', async () => {
    const { hook } = mockGate(() => ({
      status: 400,
      body: { label: 'INVALID_PARAM_VALUE', message: 'from' },
    }));
    const retractions: string[] = [];
    try {
      await new GateProvider(passthroughLimiter()).fetchTransactions({
        ...ctx,
        since,
        until,
        retractHistoryClaim: (r: string) => retractions.push(r),
      } as never);
      expect(retractions).toHaveLength(1);
      expect(retractions[0]).toContain('gate: the ledger walk failed');
    } finally {
      hook.restore();
    }
  });
});
