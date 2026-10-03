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
  }) as unknown as typeof fetch;
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
      // Inside matchresults' 120-day reach, or nothing would be asked for.
      const DAY = 24 * 60 * 60 * 1000;
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date(Date.now() - 4 * DAY),
        until: new Date(Date.now() - DAY),
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

/**
 * SC-1480 / SC-1481. Trade symbols used to come from CURRENT balances only, so
 * an asset deposited, traded and sold to zero never had its trades asked for —
 * on a provider that then declared no horizon and so claimed a complete
 * history. And a non-`ok` page ended a walk with nothing said.
 */
describe('HuobiProvider.fetchTransactions — exited assets and failed walks', () => {
  const ethSell = {
    id: 77,
    symbol: 'ethusdt',
    type: 'sell-limit',
    price: '2000',
    'filled-amount': '1',
    'filled-fees': '0',
    'fee-currency': 'usdt',
    'created-at': 1_700_000_000_000,
    'match-id': 1,
    'order-id': 1,
    'trade-id': 1,
  };

  function mockHuobi(opts: {
    deposits: FakeResponse;
    balance?: FakeResponse;
    onMatch?: (u: URL) => void;
  }) {
    const symbols: string[] = [];
    const hook = queueFetch((url) => {
      const u = new URL(url);
      if (u.pathname === '/v1/account/accounts') {
        return { body: { status: 'ok', data: [{ id: 1, type: 'spot', state: 'working' }] } };
      }
      if (u.pathname.endsWith('/balance')) {
        return (
          opts.balance ?? {
            body: {
              status: 'ok',
              data: { list: [{ currency: 'usdt', type: 'trade', balance: '2000' }] },
            },
          }
        );
      }
      if (u.pathname === '/v1/query/deposit-withdraw') {
        return u.searchParams.get('type') === 'deposit'
          ? opts.deposits
          : { body: { status: 'ok', data: [] } };
      }
      if (u.pathname === '/v1/order/matchresults') {
        const symbol = u.searchParams.get('symbol') ?? '';
        symbols.push(symbol);
        opts.onMatch?.(u);
        if (symbol === 'ethusdt') return { body: { status: 'ok', data: [ethSell] } };
        // Every other candidate is a pair Huobi does not list.
        return { body: { status: 'error', 'err-code': 'base-symbol-error' } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    return { hook, symbols };
  }

  const ethDeposit: FakeResponse = {
    body: {
      status: 'ok',
      data: [
        {
          id: 5,
          type: 'deposit',
          currency: 'eth',
          amount: '1',
          state: 'safe',
          'created-at': 1_699_000_000_000,
        },
      ],
    },
  };

  test('an asset seen only in deposits has its trades fetched, and absent pairs retract nothing', async () => {
    const { hook, symbols } = mockHuobi({ deposits: ethDeposit });
    const retractions: unknown[] = [];
    try {
      const events = await new HuobiProvider(passthroughLimiter()).fetchTransactions({
        ...ctx,
        retractHistoryClaim: (r: unknown) => retractions.push(r),
      } as never);
      expect(symbols).toContain('ethusdt');
      expect(events.map((e) => e.externalId)).toContain('match:77');
      expect(retractions).toEqual([]);
    } finally {
      hook.restore();
    }
  });

  /**
   * Even a clean run must not claim a complete history: trades-only round
   * trips cannot be enumerated, and `matchresults` reaches 120 days. The
   * router claims completeness only for a since-less run through a provider
   * with no horizon and no retraction, so the horizon is what makes it false.
   */
  test('a clean since-less run does not claim a complete history', async () => {
    const { hook } = mockHuobi({ deposits: ethDeposit });
    const retractions: unknown[] = [];
    try {
      const provider = new HuobiProvider(passthroughLimiter());
      await provider.fetchTransactions({
        ...ctx,
        retractHistoryClaim: (r: unknown) => retractions.push(r),
      } as never);
      expect(retractions).toEqual([]);
      // 120 days, less the hour kept back from matchresults' edge.
      expect(provider.transactionHistoryHorizonMs).toBe((120 * 24 - 1) * 60 * 60 * 1000);
      const claimsComplete =
        provider.transactionHistoryHorizonMs === undefined && retractions.length === 0;
      expect(claimsComplete).toBe(false);
    } finally {
      hook.restore();
    }
  });

  test('a since-less run walks fills in 48h windows back to the 120-day reach', async () => {
    const HOUR = 60 * 60 * 1000;
    const windows: Array<{ start: number; end: number }> = [];
    const { hook } = mockHuobi({
      deposits: ethDeposit,
      onMatch: (u) => {
        if (u.searchParams.get('symbol') !== 'ethusdt') return;
        windows.push({
          start: Number(u.searchParams.get('start-time')),
          end: Number(u.searchParams.get('end-time')),
        });
      },
    });
    const before = Date.now();
    try {
      await new HuobiProvider(passthroughLimiter()).fetchTransactions(ctx as never);
      const after = Date.now();
      expect(windows.length).toBeGreaterThan(1);
      for (const w of windows) {
        expect(w.end - w.start).toBeGreaterThan(0);
        expect(w.end - w.start).toBeLessThanOrEqual(48 * HOUR);
        expect(w.start).toBeGreaterThanOrEqual(before - 120 * 24 * HOUR);
      }
      // Newest first, contiguous, from now back to the reach.
      expect(windows[0]!.end).toBeGreaterThanOrEqual(before);
      expect(windows[0]!.end).toBeLessThanOrEqual(after);
      for (let i = 1; i < windows.length; i++) {
        expect(windows[i]!.end).toBe(windows[i - 1]!.start);
      }
      expect(windows.at(-1)!.start).toBeLessThanOrEqual(after - (120 * 24 - 1) * HOUR);
    } finally {
      hook.restore();
    }
  });

  test('a spot account the balance sync cannot read is warned about, not skipped silently', async () => {
    const { hook } = mockHuobi({
      deposits: ethDeposit,
      balance: { body: { status: 'error', 'err-code': 'system-busy' } },
    });
    const p = new HuobiProvider(passthroughLimiter());
    const warnings: unknown[] = [];
    (p as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger.warn = (...a) =>
      warnings.push(a);
    try {
      const holdings = await p.fetchBalances(ctx as never);
      expect(holdings).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings[0])).toContain('"accountId":1');
    } finally {
      hook.restore();
    }
  });

  test('a refused deposit walk retracts the history claim', async () => {
    const { hook } = mockHuobi({
      deposits: { body: { status: 'error', 'err-code': 'api-signature-not-valid' } },
    });
    const retractions: string[] = [];
    try {
      await new HuobiProvider(passthroughLimiter()).fetchTransactions({
        ...ctx,
        retractHistoryClaim: (r: string) => retractions.push(r),
      } as never);
      expect(retractions).toHaveLength(1);
      expect(retractions[0]).toContain('huobi: the deposit walk failed');
    } finally {
      hook.restore();
    }
  });

  test('a spot account whose balance cannot be read retracts the history claim', async () => {
    const { hook } = mockHuobi({
      deposits: ethDeposit,
      balance: { body: { status: 'error', 'err-code': 'system-busy' } },
    });
    const retractions: string[] = [];
    try {
      await new HuobiProvider(passthroughLimiter()).fetchTransactions({
        ...ctx,
        retractHistoryClaim: (r: string) => retractions.push(r),
      } as never);
      expect(retractions).toHaveLength(1);
      expect(retractions[0]).toContain('huobi: the balance read for account 1 failed');
    } finally {
      hook.restore();
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
