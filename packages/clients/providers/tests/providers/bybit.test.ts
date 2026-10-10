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
  }) as unknown as typeof fetch;
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
      if (url.includes('/v5/asset/deposit/query-internal-record')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', rows: [] } } };
      }
      if (url.includes('/v5/account/transaction-log')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', list: [] } } };
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
      if (url.includes('/v5/asset/deposit/query-internal-record')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', rows: [] } } };
      }
      if (url.includes('/v5/account/transaction-log')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', list: [] } } };
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
      if (url.includes('/v5/asset/deposit/query-internal-record')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', rows: [] } } };
      }
      if (url.includes('/v5/account/transaction-log')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', list: [] } } };
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
      if (url.includes('/v5/asset/deposit/query-internal-record')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', rows: [] } } };
      }
      if (url.includes('/v5/account/transaction-log')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', list: [] } } };
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
      if (url.includes('/v5/asset/deposit/query-internal-record')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', rows: [] } } };
      }
      if (url.includes('/v5/account/transaction-log')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', list: [] } } };
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

  // SC-166. A `since`-less run silently substitutes a 30-day look-back, and
  // `TransactionRouter` used to read "the caller asked for everything" as
  // "we fetched everything" — writing has_complete_tx_history = true over a
  // month of history, which SC-149 then feeds into cost basis. The horizon
  // is what makes that substitution visible to the router.
  test('declares the look-back its since-less run actually reaches', () => {
    const p = new BybitProvider(passthroughLimiter());
    expect(p.transactionHistoryHorizonMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('a since-less run asks for no window Bybit will reject', async () => {
    // retCode=131002 is the deposit/withdraw endpoints refusing a span wider
    // than 30 days, and the execution list refuses wider than 7. Six
    // terminal failures on mgrin's account came from asking anyway, so the
    // assertion is on every window sent, not on the happy path.
    const p = new BybitProvider(passthroughLimiter());
    const spans: Array<{ path: string; span: number }> = [];
    const fetchHook = queueFetch((url) => {
      const u = new URL(url);
      const start = Number(u.searchParams.get('startTime'));
      const end = Number(u.searchParams.get('endTime'));
      if (Number.isFinite(start) && Number.isFinite(end)) {
        spans.push({ path: u.pathname, span: end - start });
      }
      return {
        body: { retCode: 0, retMsg: 'OK', result: { list: [], rows: [], nextPageCursor: '' } },
      };
    });

    try {
      await p.fetchTransactions({ ...ctx } as never);
      expect(spans.length).toBeGreaterThan(0);
      const day = 24 * 60 * 60 * 1000;
      for (const { path, span } of spans) {
        expect(span).toBeGreaterThan(0);
        expect(span).toBeLessThanOrEqual(path.includes('/execution/') ? 7 * day : 30 * day);
      }
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

describe('BybitProvider — Funding wallet and Bybit-internal transfers (SC-1461)', () => {
  const since = new Date('2026-09-01T00:00:00Z');
  const until = new Date('2026-09-20T00:00:00Z');

  function wallets(unified: Array<[string, string]>, fund: Array<[string, string]>) {
    return (url: string): FakeResponse => {
      if (url.includes('/v5/account/wallet-balance')) {
        return {
          body: {
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [
                {
                  accountType: 'UNIFIED',
                  coin: unified.map(([coin, walletBalance]) => ({
                    coin,
                    walletBalance,
                    usdValue: '0',
                  })),
                },
              ],
            },
          },
        };
      }
      if (url.includes('/v5/asset/transfer/query-account-coins-balance')) {
        return {
          body: {
            retCode: 0,
            retMsg: 'OK',
            result: { balance: fund.map(([coin, walletBalance]) => ({ coin, walletBalance })) },
          },
        };
      }
      return { body: { retCode: 0, retMsg: 'OK', result: { rows: [], list: [] } } };
    };
  }

  async function balancesOf(handler: (url: string) => FakeResponse) {
    const p = new BybitProvider(passthroughLimiter());
    const hook = queueFetch(handler);
    try {
      const out = await p.fetchBalances(ctx as never);
      return Object.fromEntries(out.map((h) => [h.tokenIdentity.symbol, h.balance]));
    } finally {
      hook.restore();
    }
  }

  test('a balance is Funding plus Unified, per coin', async () => {
    const out = await balancesOf(
      wallets(
        [
          ['USDT', '50'],
          ['BTC', '0.1'],
        ],
        [
          ['USDT', '100'],
          ['ETH', '2'],
        ]
      )
    );
    expect(out).toEqual({ USDT: '150', BTC: '0.1', ETH: '2' });
  });

  test('moving money between Funding and Unified changes no balance', async () => {
    const inFunding = await balancesOf(wallets([], [['USDT', '4793']]));
    const inUnified = await balancesOf(wallets([['USDT', '4793']], []));
    const split = await balancesOf(wallets([['USDT', '1000']], [['USDT', '3793']]));
    expect(inFunding).toEqual({ USDT: '4793' });
    expect(inUnified).toEqual(inFunding);
    expect(split).toEqual(inFunding);
  });

  test('a Funding/Unified move never becomes a deposit or withdrawal', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const hook = queueFetch(wallets([], []));
    try {
      const events = await p.fetchTransactions({ ...(ctx as object), since, until } as never);
      expect(events).toEqual([]);
      expect(hook.calls.some((u) => u.includes('inter-transfer'))).toBe(false);
      expect(hook.calls.some((u) => u.includes('universal-transfer'))).toBe(false);
    } finally {
      hook.restore();
    }
  });

  test('a key that cannot read Funding fails loudly instead of reading Unified alone', async () => {
    const denied = (url: string): FakeResponse =>
      url.includes('query-account-coins-balance')
        ? { body: { retCode: 10005, retMsg: 'Permission denied' } }
        : wallets([['USDT', '50']], [])(url);
    const p = new BybitProvider(passthroughLimiter());
    const hook = queueFetch(denied);
    try {
      await expect(p.fetchBalances(ctx as never)).rejects.toThrow(/Funding wallet/);
      const v = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'bybit');
      expect(v.valid).toBe(false);
      expect(v.message).toMatch(/Funding wallet/);
    } finally {
      hook.restore();
    }
  });

  test('withdrawals are asked for every type, Bybit-internal included', async () => {
    const p = new BybitProvider(passthroughLimiter());
    const hook = queueFetch(wallets([], []));
    try {
      await p.fetchTransactions({ ...(ctx as object), since, until } as never);
      const wd = hook.calls.filter((u) => u.includes('/v5/asset/withdraw/query-record'));
      expect(wd.length).toBeGreaterThan(0);
      for (const u of wd) expect(new URL(u).searchParams.get('withdrawType')).toBe('2');
    } finally {
      hook.restore();
    }
  });

  test('a completed internal deposit is imported; a failed one is not', async () => {
    const handler = (url: string): FakeResponse =>
      url.includes('/v5/asset/deposit/query-internal-record')
        ? {
            body: {
              retCode: 0,
              retMsg: 'OK',
              result: {
                rows: [
                  { id: 'a1', coin: 'USDT', amount: '319', status: 2, createdTime: '1757000000' },
                  { id: 'a2', coin: 'USDT', amount: '999', status: 3, createdTime: '1757000100' },
                ],
              },
            },
          }
        : wallets([], [])(url);
    const p = new BybitProvider(passthroughLimiter());
    const hook = queueFetch(handler);
    try {
      const events = await p.fetchTransactions({ ...(ctx as object), since, until } as never);
      expect(events).toHaveLength(1);
      expect(events[0]?.externalId).toBe('internal-deposit-a1');
      expect(events[0]?.kind).toBe('deposit');
      expect(events[0]?.primary.quantity).toBe('319');
      expect(events[0]?.occurredAt.toISOString()).toBe('2025-09-04T15:33:20.000Z');
    } finally {
      hook.restore();
    }
  });
});

describe('BybitProvider — Unified transaction log (SC-1461)', () => {
  const since = new Date('2026-07-01T00:00:00Z');
  const until = new Date('2026-07-24T00:00:00Z');
  const row = (id: string, type: string, change: string, extra: Record<string, string> = {}) => ({
    id,
    currency: 'USDT',
    type,
    change,
    transactionTime: '1752768000000',
    ...extra,
  });

  async function importLogWithWarnings(list: unknown[]) {
    const p = new BybitProvider(passthroughLimiter());
    const warnings: unknown[] = [];
    const hook = queueFetch((url) => {
      if (url.includes('/v5/account/transaction-log')) {
        return { body: { retCode: 0, retMsg: 'OK', result: { nextPageCursor: '', list } } };
      }
      return { body: { retCode: 0, retMsg: 'OK', result: { rows: [], list: [] } } };
    });
    try {
      const events = await p.fetchTransactions({
        ...(ctx as object),
        since,
        until,
        noteWarning: (w: unknown) => warnings.push(w),
      } as never);
      return { events: events.filter((e) => e.externalId.startsWith('txlog-')), warnings };
    } finally {
      hook.restore();
    }
  }

  async function importLog(list: unknown[]) {
    return (await importLogWithWarnings(list)).events;
  }

  test('a futures fill, funding and a liquidation import as signed realized PnL', async () => {
    const events = await importLog([
      row('a', 'TRADE', '-1234.567891', { category: 'linear' }),
      row('b', 'TRADE', '876.54321098', { category: 'linear' }),
      row('c', 'SETTLEMENT', '3.14159265', { category: 'linear' }),
      row('d', 'LIQUIDATION', '-222.33344', { category: 'linear' }),
    ]);
    expect(events.map((e) => [e.externalId, e.kind, e.primary.quantity])).toEqual([
      ['txlog-a', 'realized_pnl', '-1234.567891'],
      ['txlog-b', 'realized_pnl', '876.54321098'],
      ['txlog-c', 'realized_pnl', '3.14159265'],
      ['txlog-d', 'realized_pnl', '-222.33344'],
    ]);
  });

  test('spot fills and Funding/Unified transfers in the log are not imported twice', async () => {
    const events = await importLog([
      row('s', 'TRADE', '-2910.64', { category: 'spot' }),
      row('i', 'TRANSFER_IN', '5000'),
      row('o', 'TRANSFER_OUT', '-300'),
      row('x', 'EXEMPTED_INTEREST', '0'),
    ]);
    expect(events).toEqual([]);
  });

  test('borrow interest paid is a fee; interest received is interest', async () => {
    const events = await importLog([row('p', 'INTEREST', '-0.0123'), row('r', 'INTEREST', '0.5')]);
    expect(events.map((e) => [e.kind, e.primary.quantity])).toEqual([
      ['fee', '-0.0123'],
      ['interest', '0.5'],
    ]);
  });

  test('a row repeated across two windows is imported once', async () => {
    const dup = row('same', 'SETTLEMENT', '-1.11122233', { category: 'linear' });
    const events = await importLog([dup, dup]);
    expect(events).toHaveLength(1);
  });

  test('a log type we do not import is named and counted, never guessed into a row (SC-1591)', async () => {
    const { events, warnings } = await importLogWithWarnings([
      row('f', 'TRADE', '-1.5', { category: 'linear' }),
      row('b1', 'BONUS', '5'),
      row('b2', 'BONUS', '2'),
      row('a1', 'AIRDROP', '1'),
    ]);
    expect(events.map((e) => e.externalId)).toEqual(['txlog-f']);
    expect(warnings).toHaveLength(1);
    const notice = warnings[0] as {
      key: string;
      params: { count: number };
      lists: { types: { items: Array<{ text: string }> } };
    };
    expect(notice.key).toBe('v3.jobs.notices.bybitUnlistedLogTypes');
    expect(notice.params.count).toBe(3);
    expect(notice.lists.types.items.map((i) => i.text)).toEqual(['"BONUS" (2)', '"AIRDROP" (1)']);
  });

  test('an unlisted row that moves no balance raises nothing (SC-1591)', async () => {
    const { events, warnings } = await importLogWithWarnings([row('z', 'BONUS', '0')]);
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('every type the import knows stays silent', async () => {
    const { warnings } = await importLogWithWarnings([
      row('t', 'TRADE', '-1', { category: 'linear' }),
      row('s', 'TRADE', '-2', { category: 'spot' }),
      row('c', 'SETTLEMENT', '1', { category: 'linear' }),
      row('l', 'LIQUIDATION', '-1', { category: 'linear' }),
      row('d', 'DELIVERY', '1', { category: 'linear' }),
      row('a', 'ADL', '1', { category: 'linear' }),
      row('i', 'TRANSFER_IN', '5'),
      row('o', 'TRANSFER_OUT', '-5'),
      row('x', 'EXEMPTED_INTEREST', '0'),
      row('n', 'INTEREST', '-0.1'),
      row('k1-s', 'CURRENCY_SELL', '-0.1', { currency: 'BTC', tradeId: 'k1' }),
      row('k1-b', 'CURRENCY_BUY', '1', { tradeId: 'k1' }),
    ]);
    expect(warnings).toEqual([]);
  });

  test("Bybit's auto-repay conversion imports as one spot sale", async () => {
    const events = await importLog([
      row('t1-s', 'CURRENCY_SELL', '-0.00043219', { currency: 'BTC', tradeId: 't1' }),
      row('t1-b', 'CURRENCY_BUY', '12.34567891', { tradeId: 't1' }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('sell');
    expect(events[0]?.primary.tokenIdentity.symbol).toBe('BTC');
    expect(events[0]?.primary.quantity).toBe('-0.00043219');
    expect(events[0]?.counter?.tokenIdentity.symbol).toBe('USDT');
    expect(events[0]?.counter?.quantity).toBe('12.34567891');
  });
});

describe('BybitProvider — a rejected key is an auth failure (SC-1686)', () => {
  async function kindOf(retCode: number, retMsg: string, call: 'balances' | 'transactions') {
    const p = new BybitProvider(passthroughLimiter());
    const hook = queueFetch(() => ({ body: { retCode, retMsg } }));
    try {
      if (call === 'balances') await p.fetchBalances(ctx as never);
      else
        await p.fetchTransactions({
          ...ctx,
          since: new Date('2026-10-01T00:00:00Z'),
          until: new Date('2026-10-02T00:00:00Z'),
        } as never);
    } catch (err) {
      return (err as { kind?: string }).kind;
    } finally {
      hook.restore();
    }
    return 'resolved';
  }

  for (const [retCode, retMsg] of [
    [33004, 'Your api key has expired.'],
    [10003, 'API key is invalid.'],
    [10004, 'Error sign, please check your signature generation algorithm.'],
    [10007, 'User authentication failed.'],
    [10010, "Unmatched IP, please check your API key's bound IP addresses."],
  ] as const) {
    test(`retCode ${retCode} fails a balance and a transaction read as auth-failed`, async () => {
      expect(await kindOf(retCode, retMsg, 'balances')).toBe('auth-failed');
      expect(await kindOf(retCode, retMsg, 'transactions')).toBe('auth-failed');
    });
  }

  test('control: an ordinary refusal stays unrecoverable', async () => {
    expect(await kindOf(10001, 'params error', 'balances')).toBe('unrecoverable');
  });
});
