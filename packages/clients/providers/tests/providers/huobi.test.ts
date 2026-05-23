import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { buildCandidateSymbols, HuobiProvider } from '../../src/providers/huobi';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'huobi',
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

describe('HuobiProvider', () => {
  test('canFetchBalances gates on huobi', () => {
    const p = new HuobiProvider(passthroughLimiter());
    expect(p.canFetchBalances('huobi')).toBe(true);
    expect(p.canFetchBalances('binance')).toBe(false);
  });

  test('canFetchTransactions gates on huobi', () => {
    const p = new HuobiProvider(passthroughLimiter());
    expect(p.canFetchTransactions('huobi')).toBe(true);
    expect(p.canFetchTransactions('binance')).toBe(false);
  });

  test('declares transactions capability', () => {
    const p = new HuobiProvider(passthroughLimiter());
    expect(p.capabilities).toContain('transactions');
  });

  test('fetchBalances resolves spot accounts and sums per-currency balances', async () => {
    const p = new HuobiProvider(passthroughLimiter());
    const fetchHook = queueFetch((url) => {
      if (url.includes('/v1/account/accounts/123/balance')) {
        return {
          body: {
            status: 'ok',
            data: {
              id: 123,
              type: 'spot',
              state: 'working',
              list: [
                { currency: 'btc', type: 'trade', balance: '0.5' },
                { currency: 'btc', type: 'frozen', balance: '0.1' },
                { currency: 'usdt', type: 'trade', balance: '0' },
              ],
            },
          },
        };
      }
      return {
        body: { status: 'ok', data: [{ id: 123, type: 'spot', state: 'working' }] },
      };
    });
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toHaveLength(1);
      expect(out[0]?.tokenIdentity.symbol).toBe('BTC');
      expect(out[0]?.balance).toBe('0.6');
      const meta = out[0]?.tokenIdentity.providerMetadata as { huobi: { currency: string } };
      expect(meta.huobi.currency).toBe('btc');
    } finally {
      fetchHook.restore();
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new HuobiProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'binance');
    expect(r.valid).toBe(false);
  });

  test('validateCredentials returns true on status=ok', async () => {
    const p = new HuobiProvider(passthroughLimiter());
    const fetchHook = queueFetch(() => ({ body: { status: 'ok' } }));
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'huobi');
      expect(r.valid).toBe(true);
    } finally {
      fetchHook.restore();
    }
  });

  test('validateCredentials maps 401 to invalid', async () => {
    const p = new HuobiProvider(passthroughLimiter());
    const fetchHook = queueFetch(() => ({ body: 'Unauthorized', status: 401 }));
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'huobi');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('huobi HTTP 401');
    } finally {
      fetchHook.restore();
    }
  });
});

describe('HuobiProvider buildCandidateSymbols', () => {
  test('cross-products currencies with quote pool, stablecoins first', () => {
    const out = buildCandidateSymbols(['btc', 'eth', 'sol'], 30);
    expect(out.slice(0, 6)).toEqual([
      'btcusdt',
      'ethusdt',
      'solusdt',
      'btcusdc',
      'ethusdc',
      'solusdc',
    ]);
  });

  test('drops self-pairs (btcbtc, usdtusdt)', () => {
    const out = buildCandidateSymbols(['btc', 'usdt'], 30);
    expect(out).not.toContain('btcbtc');
    expect(out).not.toContain('usdtusdt');
    expect(out).toContain('btcusdt');
    expect(out).toContain('usdtbtc');
  });

  test('caps at the supplied limit', () => {
    const out = buildCandidateSymbols(
      ['btc', 'eth', 'sol', 'ada', 'dot', 'avax', 'xrp', 'doge', 'ltc', 'matic'],
      30
    );
    expect(out).toHaveLength(30);
  });
});

describe('HuobiProvider fetchTransactions', () => {
  test('paginates matchresults via from-id and maps buy/sell sides', async () => {
    const p = new HuobiProvider(passthroughLimiter());

    const matchPagesBySymbol = new Map<string, number>();
    const fetchHook = queueFetch((url) => {
      if (url.includes('/v1/account/accounts') && !url.includes('/balance')) {
        return {
          body: { status: 'ok', data: [{ id: 1, type: 'spot', state: 'working' }] },
        };
      }
      if (url.includes('/balance')) {
        return {
          body: {
            status: 'ok',
            data: {
              id: 1,
              type: 'spot',
              state: 'working',
              list: [
                { currency: 'btc', type: 'trade', balance: '0.5' },
                { currency: 'eth', type: 'trade', balance: '2' },
              ],
            },
          },
        };
      }
      if (url.includes('/v1/order/matchresults')) {
        const u = new URL(url);
        const symbol = u.searchParams.get('symbol') ?? '';
        const fromId = u.searchParams.get('from-id');
        const page = (matchPagesBySymbol.get(symbol) ?? 0) + 1;
        matchPagesBySymbol.set(symbol, page);
        if (symbol === 'btcusdt' && !fromId) {
          return {
            body: {
              status: 'ok',
              data: [
                {
                  id: 1001,
                  symbol: 'btcusdt',
                  type: 'buy-market',
                  price: '50000',
                  'filled-amount': '0.1',
                  'filled-fees': '0.5',
                  'fee-currency': 'usdt',
                  'created-at': 1704067200000,
                  'match-id': 1,
                  'order-id': 1,
                  'trade-id': 1,
                },
                {
                  id: 1002,
                  symbol: 'btcusdt',
                  type: 'sell-limit',
                  price: '60000',
                  'filled-amount': '0.05',
                  'filled-fees': '0.001',
                  'fee-currency': 'btc',
                  'created-at': 1704153600000,
                  'match-id': 2,
                  'order-id': 2,
                  'trade-id': 2,
                },
              ],
            },
          };
        }
        return { body: { status: 'ok', data: [] } };
      }
      if (url.includes('/v1/query/deposit-withdraw')) {
        return { body: { status: 'ok', data: [] } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date('2024-01-01T00:00:00Z'),
        until: new Date('2024-01-05T00:00:00Z'),
      } as never);

      const trades = events.filter((e) => e.kind === 'buy' || e.kind === 'sell');
      expect(trades).toHaveLength(2);

      const buy = events.find((e) => e.externalId === 'match:1001');
      expect(buy?.kind).toBe('buy');
      expect(buy?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(buy?.primary.quantity).toBe('0.1');
      expect(buy?.counter?.tokenIdentity.symbol).toBe('USDT');
      expect(buy?.counter?.quantity).toBe('-5000'); // 0.1 * 50000 outflow
      expect(buy?.fee?.tokenIdentity.symbol).toBe('USDT');
      expect(buy?.fee?.quantity).toBe('-0.5');

      const sell = events.find((e) => e.externalId === 'match:1002');
      expect(sell?.kind).toBe('sell');
      expect(sell?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(sell?.primary.quantity).toBe('-0.05');
      expect(sell?.counter?.tokenIdentity.symbol).toBe('USDT');
      expect(sell?.counter?.quantity).toBe('3000'); // 0.05 * 60000 inflow
      expect(sell?.fee?.tokenIdentity.symbol).toBe('BTC');
    } finally {
      fetchHook.restore();
    }
  });

  test('skips matchresults symbols that return status=error', async () => {
    const p = new HuobiProvider(passthroughLimiter());
    const fetchHook = queueFetch((url) => {
      if (url.includes('/v1/account/accounts') && !url.includes('/balance')) {
        return {
          body: { status: 'ok', data: [{ id: 1, type: 'spot', state: 'working' }] },
        };
      }
      if (url.includes('/balance')) {
        return {
          body: {
            status: 'ok',
            data: {
              id: 1,
              type: 'spot',
              state: 'working',
              list: [{ currency: 'btc', type: 'trade', balance: '0.5' }],
            },
          },
        };
      }
      if (url.includes('/v1/order/matchresults')) {
        return {
          body: {
            status: 'error',
            'err-code': 'base-symbol-error',
            'err-msg': 'symbol is invalid',
          },
        };
      }
      if (url.includes('/v1/query/deposit-withdraw')) {
        return { body: { status: 'ok', data: [] } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events).toHaveLength(0);
    } finally {
      fetchHook.restore();
    }
  });

  test('maps deposit-withdraw rows to deposit + withdraw events', async () => {
    const p = new HuobiProvider(passthroughLimiter());
    const fetchHook = queueFetch((url) => {
      if (url.includes('/v1/account/accounts') && !url.includes('/balance')) {
        return {
          body: { status: 'ok', data: [{ id: 1, type: 'spot', state: 'working' }] },
        };
      }
      if (url.includes('/balance')) {
        return {
          body: {
            status: 'ok',
            data: {
              id: 1,
              type: 'spot',
              state: 'working',
              list: [{ currency: 'usdt', type: 'trade', balance: '1000' }],
            },
          },
        };
      }
      if (url.includes('/v1/order/matchresults')) {
        return { body: { status: 'ok', data: [] } };
      }
      if (url.includes('/v1/query/deposit-withdraw')) {
        const u = new URL(url);
        const type = u.searchParams.get('type');
        if (type === 'deposit') {
          return {
            body: {
              status: 'ok',
              data: [
                {
                  id: 9001,
                  type: 'deposit',
                  currency: 'usdt',
                  'tx-hash': '0xdeadbeef',
                  amount: '500',
                  state: 'safe',
                  'created-at': 1704067200000,
                  'updated-at': 1704067260000,
                },
              ],
            },
          };
        }
        if (type === 'withdraw') {
          return {
            body: {
              status: 'ok',
              data: [
                {
                  id: 9002,
                  type: 'withdraw',
                  currency: 'usdt',
                  'tx-hash': '0xcafebabe',
                  amount: '100',
                  fee: '1',
                  state: 'confirmed',
                  'created-at': 1704153600000,
                  'updated-at': 1704153660000,
                },
              ],
            },
          };
        }
        return { body: { status: 'ok', data: [] } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions(ctx as never);
      const dep = events.find((e) => e.kind === 'deposit');
      expect(dep?.externalId).toBe('deposit:0xdeadbeef');
      expect(dep?.primary.tokenIdentity.symbol).toBe('USDT');
      expect(dep?.primary.quantity).toBe('500');
      expect(dep?.fee).toBeUndefined();

      const wd = events.find((e) => e.kind === 'withdraw');
      expect(wd?.externalId).toBe('withdraw:0xcafebabe');
      expect(wd?.primary.tokenIdentity.symbol).toBe('USDT');
      expect(wd?.primary.quantity).toBe('-100');
      expect(wd?.fee?.quantity).toBe('-1');
    } finally {
      fetchHook.restore();
    }
  });

  test('filters deposit-withdraw rows by [since, until] timestamp', async () => {
    const p = new HuobiProvider(passthroughLimiter());
    const fetchHook = queueFetch((url) => {
      if (url.includes('/v1/account/accounts') && !url.includes('/balance')) {
        return {
          body: { status: 'ok', data: [{ id: 1, type: 'spot', state: 'working' }] },
        };
      }
      if (url.includes('/balance')) {
        return {
          body: {
            status: 'ok',
            data: {
              id: 1,
              type: 'spot',
              state: 'working',
              list: [{ currency: 'usdt', type: 'trade', balance: '1' }],
            },
          },
        };
      }
      if (url.includes('/v1/order/matchresults')) {
        return { body: { status: 'ok', data: [] } };
      }
      if (url.includes('/v1/query/deposit-withdraw')) {
        return {
          body: {
            status: 'ok',
            data: [
              {
                id: 1,
                type: 'deposit',
                currency: 'usdt',
                amount: '10',
                state: 'safe',
                'created-at': 1700000000000, // before window
                'updated-at': 1700000000000,
              },
              {
                id: 2,
                type: 'deposit',
                currency: 'usdt',
                amount: '20',
                state: 'safe',
                'created-at': 1704090000000, // inside window
                'updated-at': 1704090000000,
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date('2024-01-01T00:00:00Z'),
        until: new Date('2024-01-05T00:00:00Z'),
      } as never);
      const deposits = events.filter((e) => e.kind === 'deposit');
      expect(deposits).toHaveLength(1);
      expect(deposits[0]?.primary.quantity).toBe('20');
    } finally {
      fetchHook.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Live test against api.huobi.pro — opt-in via SCANI_LIVE=1.
// Requires SCANI_LIVE_HUOBI_API_KEY / SCANI_LIVE_HUOBI_API_SECRET.
// Use a throwaway account with read-only keys: there's no Huobi sandbox.
// ---------------------------------------------------------------------------
const liveDescribe =
  process.env.SCANI_LIVE === '1' &&
  process.env.SCANI_LIVE_HUOBI_API_KEY &&
  process.env.SCANI_LIVE_HUOBI_API_SECRET
    ? describe
    : describe.skip;

liveDescribe('HuobiProvider [live]', () => {
  test('fetchTransactions hits api.huobi.pro without HTTP error', async () => {
    const p = new HuobiProvider(passthroughLimiter());
    const liveCtx = {
      ...ctx,
      resolveCredentials: async () => ({
        apiKey: process.env.SCANI_LIVE_HUOBI_API_KEY!,
        apiSecret: process.env.SCANI_LIVE_HUOBI_API_SECRET!,
      }),
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      until: new Date(),
    };
    const events = await p.fetchTransactions(liveCtx as never);
    expect(Array.isArray(events)).toBe(true);
  });
});
