import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { BybitProvider } from '../../src/providers/bybit';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'bybit',
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

describe('BybitProvider', () => {
  test('canFetchBalances gates on bybit', () => {
    const p = new BybitProvider(passthroughLimiter());
    expect(p.canFetchBalances('bybit')).toBe(true);
    expect(p.canFetchBalances('okx')).toBe(false);
  });

  test('canFetchTransactions gates on bybit', () => {
    const p = new BybitProvider(passthroughLimiter());
    expect(p.canFetchTransactions('bybit')).toBe(true);
    expect(p.canFetchTransactions('okx')).toBe(false);
  });

  test('fetchBalances parses retCode=0 envelope, drops zero-wallet rows, uppercases symbol', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const fetchHook = queueFetch(() => ({
      body: {
        retCode: 0,
        retMsg: 'OK',
        result: {
          list: [
            {
              accountType: 'UNIFIED',
              coin: [
                { coin: 'btc', walletBalance: '0.5', usdValue: '100' },
                { coin: 'usdt', walletBalance: '0', usdValue: '0' },
              ],
            },
          ],
        },
      },
    }));
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toHaveLength(1);
      expect(out[0]?.tokenIdentity.symbol).toBe('BTC');
      expect(out[0]?.balance).toBe('0.5');
      const meta = out[0]?.tokenIdentity.providerMetadata as { bybit: { coin: string } };
      expect(meta.bybit.coin).toBe('btc');
    } finally {
      fetchHook.restore();
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'okx');
    expect(r.valid).toBe(false);
  });

  test('validateCredentials returns true on retCode=0', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const fetchHook = queueFetch(() => ({ body: { retCode: 0, retMsg: 'OK' } }));
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'bybit');
      expect(r.valid).toBe(true);
    } finally {
      fetchHook.restore();
    }
  });

  test('validateCredentials returns false on non-zero retCode', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const fetchHook = queueFetch(() => ({
      body: { retCode: 10003, retMsg: 'Invalid api key' },
    }));
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'bybit');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('Invalid api key');
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions paginates execution-list via cursor and maps a Buy + Sell trade', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date('2024-01-05T00:00:00Z'); // < 7 days → single window

    let executionPage = 0;
    const fetchHook = queueFetch((url) => {
      if (url.includes('/v5/execution/list')) {
        executionPage += 1;
        if (executionPage === 1) {
          return {
            body: {
              retCode: 0,
              retMsg: 'OK',
              result: {
                nextPageCursor: 'cursor-2',
                list: [
                  {
                    symbol: 'BTCUSDT',
                    side: 'Buy',
                    execId: 'exec-1',
                    execQty: '0.1',
                    execValue: '5000',
                    execFee: '0.5',
                    feeCurrency: 'USDT',
                    execTime: '1704067200000',
                  },
                  {
                    symbol: 'ETHUSDT',
                    side: 'Sell',
                    execId: 'exec-2',
                    execQty: '2',
                    execValue: '6000',
                    execFee: '0.001',
                    feeCurrency: 'ETH',
                    execTime: '1704153600000',
                  },
                ],
              },
            },
          };
        }
        // page 2: empty terminator (cursor was provided, but list is empty)
        return {
          body: {
            retCode: 0,
            retMsg: 'OK',
            result: { nextPageCursor: '', list: [] },
          },
        };
      }
      if (url.includes('/v5/asset/deposit/query-record')) {
        return {
          body: {
            retCode: 0,
            retMsg: 'OK',
            result: { nextPageCursor: '', rows: [] },
          },
        };
      }
      if (url.includes('/v5/asset/withdraw/query-record')) {
        return {
          body: {
            retCode: 0,
            retMsg: 'OK',
            result: { nextPageCursor: '', rows: [] },
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      expect(executionPage).toBe(2); // cursor advance walked once
      expect(events).toHaveLength(2);

      const buy = events.find((e) => e.externalId === 'exec-1');
      expect(buy?.kind).toBe('buy');
      expect(buy?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(buy?.primary.quantity).toBe('0.1'); // positive
      expect(buy?.counter?.tokenIdentity.symbol).toBe('USDT');
      expect(buy?.counter?.quantity).toBe('-5000'); // outflow
      expect(buy?.fee?.tokenIdentity.symbol).toBe('USDT');
      expect(buy?.fee?.quantity).toBe('-0.5');

      const sell = events.find((e) => e.externalId === 'exec-2');
      expect(sell?.kind).toBe('sell');
      expect(sell?.primary.tokenIdentity.symbol).toBe('ETH');
      expect(sell?.primary.quantity).toBe('-2'); // outflow
      expect(sell?.counter?.tokenIdentity.symbol).toBe('USDT');
      expect(sell?.counter?.quantity).toBe('6000'); // inflow
      expect(sell?.fee?.tokenIdentity.symbol).toBe('ETH');
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions slides through 3 windows over a 21-day range', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date(since.getTime() + 21 * 24 * 60 * 60 * 1000); // 21 days exact

    const seenExecutionWindows: Array<{ startTime: string; endTime: string }> = [];
    const fetchHook = queueFetch((url) => {
      if (url.includes('/v5/execution/list')) {
        const u = new URL(url);
        const startTime = u.searchParams.get('startTime') ?? '';
        const endTime = u.searchParams.get('endTime') ?? '';
        // Only record on first page of each window (cursor absent).
        if (!u.searchParams.get('cursor')) {
          seenExecutionWindows.push({ startTime, endTime });
        }
        return {
          body: {
            retCode: 0,
            retMsg: 'OK',
            result: { nextPageCursor: '', list: [] },
          },
        };
      }
      if (
        url.includes('/v5/asset/deposit/query-record') ||
        url.includes('/v5/asset/withdraw/query-record')
      ) {
        return {
          body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', rows: [] } },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      expect(events).toHaveLength(0);
      expect(seenExecutionWindows).toHaveLength(3);
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(Number(seenExecutionWindows[0]?.startTime)).toBe(since.getTime());
      expect(Number(seenExecutionWindows[0]?.endTime)).toBe(since.getTime() + sevenDaysMs);
      expect(Number(seenExecutionWindows[1]?.startTime)).toBe(since.getTime() + sevenDaysMs);
      expect(Number(seenExecutionWindows[1]?.endTime)).toBe(since.getTime() + 2 * sevenDaysMs);
      expect(Number(seenExecutionWindows[2]?.startTime)).toBe(since.getTime() + 2 * sevenDaysMs);
      expect(Number(seenExecutionWindows[2]?.endTime)).toBe(until.getTime());
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions chunks deposit queries into <=30d windows over a 90-day range', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const since = new Date('2026-01-01T00:00:00Z');
    const until = new Date('2026-04-01T00:00:00Z'); // 90 days

    const windows: Array<{ start: number; end: number }> = [];
    const fetchHook = queueFetch((url) => {
      if (url.includes('/v5/execution/list')) {
        return {
          body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', list: [] } },
        };
      }
      if (url.includes('/v5/asset/deposit/query-record')) {
        const u = new URL(url);
        if (!u.searchParams.get('cursor')) {
          windows.push({
            start: Number(u.searchParams.get('startTime')),
            end: Number(u.searchParams.get('endTime')),
          });
        }
        return {
          body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', rows: [] } },
        };
      }
      if (url.includes('/v5/asset/withdraw/query-record')) {
        return {
          body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', rows: [] } },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      await p.fetchTransactions({ ...ctx, since, until } as never);
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(windows.length).toBeGreaterThanOrEqual(3);
      for (const w of windows) expect(w.end - w.start).toBeLessThanOrEqual(thirtyDaysMs);
      expect(Math.min(...windows.map((w) => w.start))).toBe(since.getTime());
      expect(Math.max(...windows.map((w) => w.end))).toBe(until.getTime());
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions chunks withdrawal queries into <=30d windows over a 90-day range', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const since = new Date('2026-01-01T00:00:00Z');
    const until = new Date('2026-04-01T00:00:00Z'); // 90 days

    const windows: Array<{ start: number; end: number }> = [];
    const fetchHook = queueFetch((url) => {
      if (url.includes('/v5/execution/list')) {
        return {
          body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', list: [] } },
        };
      }
      if (url.includes('/v5/asset/deposit/query-record')) {
        return {
          body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', rows: [] } },
        };
      }
      if (url.includes('/v5/asset/withdraw/query-record')) {
        const u = new URL(url);
        if (!u.searchParams.get('cursor')) {
          windows.push({
            start: Number(u.searchParams.get('startTime')),
            end: Number(u.searchParams.get('endTime')),
          });
        }
        return {
          body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', rows: [] } },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      await p.fetchTransactions({ ...ctx, since, until } as never);
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(windows.length).toBeGreaterThanOrEqual(3);
      for (const w of windows) expect(w.end - w.start).toBeLessThanOrEqual(thirtyDaysMs);
      expect(Math.min(...windows.map((w) => w.start))).toBe(since.getTime());
      expect(Math.max(...windows.map((w) => w.end))).toBe(until.getTime());
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions maps deposits + withdrawals from their dedicated endpoints', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date('2024-01-05T00:00:00Z');

    const fetchHook = queueFetch((url) => {
      if (url.includes('/v5/execution/list')) {
        return {
          body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', list: [] } },
        };
      }
      if (url.includes('/v5/asset/deposit/query-record')) {
        return {
          body: {
            retCode: 0,
            retMsg: 'OK',
            result: {
              nextPageCursor: '',
              rows: [
                {
                  coin: 'USDT',
                  amount: '1000',
                  txID: '0xabc',
                  successAt: '1704067200000',
                },
              ],
            },
          },
        };
      }
      if (url.includes('/v5/asset/withdraw/query-record')) {
        return {
          body: {
            retCode: 0,
            retMsg: 'OK',
            result: {
              nextPageCursor: '',
              rows: [
                {
                  coin: 'BTC',
                  amount: '0.05',
                  withdrawId: 'wd-1',
                  txID: '0xdef',
                  withdrawFee: '0.0005',
                  updateTime: '1704153600000',
                },
              ],
            },
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      const dep = events.find((e) => e.kind === 'deposit');
      expect(dep?.externalId).toBe('0xabc');
      expect(dep?.primary.tokenIdentity.symbol).toBe('USDT');
      expect(dep?.primary.quantity).toBe('1000'); // positive

      const wd = events.find((e) => e.kind === 'withdraw');
      expect(wd?.externalId).toBe('wd-1');
      expect(wd?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(wd?.primary.quantity).toBe('-0.05'); // outflow
      expect(wd?.fee?.quantity).toBe('-0.0005');
    } finally {
      fetchHook.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Live test against testnet — opt-in via SCANI_LIVE=1.
// Requires SCANI_TESTNET_BYBIT_API_KEY / SCANI_TESTNET_BYBIT_API_SECRET
// + SCANI_TESTNET_BYBIT_BASE_URL=https://api-testnet.bybit.com.
// ---------------------------------------------------------------------------
const liveDescribe =
  process.env.SCANI_LIVE === '1' &&
  process.env.SCANI_TESTNET_BYBIT_API_KEY &&
  process.env.SCANI_TESTNET_BYBIT_API_SECRET
    ? describe
    : describe.skip;

liveDescribe('BybitProvider [live testnet]', () => {
  test('fetchTransactions hits api-testnet.bybit.com without HTTP error', async () => {
    const baseUrl = process.env.SCANI_TESTNET_BYBIT_BASE_URL ?? 'https://api-testnet.bybit.com';
    const p = new BybitProvider(passthroughLimiter(), baseUrl);
    const liveCtx = {
      ...ctx,
      resolveCredentials: async () => ({
        apiKey: process.env.SCANI_TESTNET_BYBIT_API_KEY!,
        apiSecret: process.env.SCANI_TESTNET_BYBIT_API_SECRET!,
      }),
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      until: new Date(),
    };
    const events = await p.fetchTransactions(liveCtx as never);
    expect(Array.isArray(events)).toBe(true);
  });
});
