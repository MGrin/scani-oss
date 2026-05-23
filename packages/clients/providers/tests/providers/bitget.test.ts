import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { BitgetProvider } from '../../src/providers/bitget';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'bitget',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's', passphrase: 'p' }),
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

describe('BitgetProvider', () => {
  test('canFetchBalances gates on bitget institution code', () => {
    const p = new BitgetProvider(passthroughLimiter());
    expect(p.canFetchBalances('bitget')).toBe(true);
    expect(p.canFetchBalances('binance')).toBe(false);
  });

  test('canFetchTransactions gates on bitget', () => {
    const p = new BitgetProvider(passthroughLimiter());
    expect(p.canFetchTransactions('bitget')).toBe(true);
    expect(p.canFetchTransactions('okx')).toBe(false);
  });

  test('signRequest includes the query string in the HMAC pre-sign', () => {
    // The V2 spec is `timestamp + method + requestPath + ?query + body`.
    // Regression guard: an earlier signRequest forgot the query segment,
    // so any signed call with query params got rejected with sign-mismatch.
    const p = new BitgetProvider(passthroughLimiter());
    const originalNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const headers = (
        p as unknown as {
          signRequest: (
            r: { method: string; url: string; query?: string; body?: string },
            c: { apiKey: string; apiSecret: string; passphrase?: string }
          ) => Record<string, string>;
        }
      ).signRequest(
        { method: 'GET', url: '/api/v2/spot/trade/fills', query: 'limit=100&startTime=1' },
        { apiKey: 'k', apiSecret: 's', passphrase: 'p' }
      );
      const expected = crypto
        .createHmac('sha256', 's')
        .update('1700000000000GET/api/v2/spot/trade/fills?limit=100&startTime=1')
        .digest('base64');
      expect(headers['ACCESS-SIGN']).toBe(expected);
    } finally {
      Date.now = originalNow;
    }
  });

  test('signRequest omits the ?query segment when no query is provided', () => {
    const p = new BitgetProvider(passthroughLimiter());
    const originalNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const headers = (
        p as unknown as {
          signRequest: (
            r: { method: string; url: string; query?: string; body?: string },
            c: { apiKey: string; apiSecret: string; passphrase?: string }
          ) => Record<string, string>;
        }
      ).signRequest(
        { method: 'GET', url: '/api/v2/spot/account/assets' },
        { apiKey: 'k', apiSecret: 's', passphrase: 'p' }
      );
      const expected = crypto
        .createHmac('sha256', 's')
        .update('1700000000000GET/api/v2/spot/account/assets')
        .digest('base64');
      expect(headers['ACCESS-SIGN']).toBe(expected);
    } finally {
      Date.now = originalNow;
    }
  });

  test('fetchBalances merges available + frozen + locked, drops zero, uppercases symbol', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const fetchHook = queueFetch(() => ({
      body: {
        code: '00000',
        msg: 'success',
        data: [
          { coin: 'btc', available: '0.5', frozen: '0', locked: '0.1' },
          { coin: 'usdt', available: '0', frozen: '0', locked: '0' },
        ],
      },
    }));
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toHaveLength(1);
      expect(out[0]?.tokenIdentity.symbol).toBe('BTC');
      expect(out[0]?.balance).toBe('0.6');
      const meta = out[0]?.tokenIdentity.providerMetadata as { bitget: { coin: string } };
      expect(meta.bitget.coin).toBe('btc');
    } finally {
      fetchHook.restore();
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's', passphrase: 'p' }, 'okx');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('Wrong institution');
  });

  test('validateCredentials rejects missing passphrase', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'bitget');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('passphrase');
  });

  test('validateCredentials returns true on success envelope', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const fetchHook = queueFetch(() => ({
      body: { code: '00000', msg: 'ok', data: [] },
    }));
    try {
      const r = await p.validateCredentials(
        { apiKey: 'k', apiSecret: 's', passphrase: 'p' },
        'bitget'
      );
      expect(r.valid).toBe(true);
    } finally {
      fetchHook.restore();
    }
  });

  test('validateCredentials maps 401 to invalid', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    try {
      const r = await p.validateCredentials(
        { apiKey: 'k', apiSecret: 's', passphrase: 'p' },
        'bitget'
      );
      expect(r.valid).toBe(false);
      expect(r.message).toContain('bitget HTTP 401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions maps fills to buy/sell with proper signs + fee detail', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date('2024-01-05T00:00:00Z');

    const fetchHook = queueFetch((url) => {
      if (url.includes('/api/v2/spot/trade/fills')) {
        return {
          body: {
            code: '00000',
            msg: 'success',
            data: [
              {
                symbol: 'BTCUSDT',
                orderId: 'o-1',
                tradeId: 'trade-1',
                side: 'buy',
                priceAvg: '50000',
                size: '0.1',
                amount: '5000',
                feeDetail: { feeCoin: 'USDT', totalFee: '-0.5' },
                cTime: '1704067200000',
              },
              {
                symbol: 'ETHUSDT',
                orderId: 'o-2',
                tradeId: 'trade-2',
                side: 'sell',
                priceAvg: '3000',
                size: '2',
                amount: '6000',
                feeDetail: { feeCoin: 'ETH', totalFee: '-0.001' },
                cTime: '1704153600000',
              },
            ],
          },
        };
      }
      if (url.includes('/api/v2/spot/wallet/deposit-records')) {
        return { body: { code: '00000', msg: 'success', data: [] } };
      }
      if (url.includes('/api/v2/spot/wallet/withdrawal-records')) {
        return { body: { code: '00000', msg: 'success', data: [] } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      expect(events).toHaveLength(2);

      const buy = events.find((e) => e.externalId === 'trade-1');
      expect(buy?.kind).toBe('buy');
      expect(buy?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(buy?.primary.quantity).toBe('0.1'); // positive (inflow)
      expect(buy?.counter?.tokenIdentity.symbol).toBe('USDT');
      expect(buy?.counter?.quantity).toBe('-5000'); // outflow
      expect(buy?.fee?.tokenIdentity.symbol).toBe('USDT');
      expect(buy?.fee?.quantity).toBe('-0.5');
      expect(buy?.priceNative?.value).toBe('50000');
      expect(buy?.priceNative?.quoteIdentity.symbol).toBe('USDT');

      const sell = events.find((e) => e.externalId === 'trade-2');
      expect(sell?.kind).toBe('sell');
      expect(sell?.primary.tokenIdentity.symbol).toBe('ETH');
      expect(sell?.primary.quantity).toBe('-2'); // outflow
      expect(sell?.counter?.tokenIdentity.symbol).toBe('USDT');
      expect(sell?.counter?.quantity).toBe('6000'); // inflow
      expect(sell?.fee?.tokenIdentity.symbol).toBe('ETH');
      expect(sell?.fee?.quantity).toBe('-0.001');
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions paginates fills via idLessThan cursor', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date('2024-01-05T00:00:00Z');

    // Build 100 fills for page 1 so the iterator advances; page 2 returns
    // < limit and terminates. We assert idLessThan was set to the smallest
    // tradeId from page 1.
    const page1: unknown[] = [];
    for (let i = 0; i < 100; i += 1) {
      page1.push({
        symbol: 'BTCUSDT',
        orderId: `o-${i}`,
        tradeId: `trade-${1000 - i}`,
        side: 'buy',
        priceAvg: '50000',
        size: '0.01',
        amount: '500',
        feeDetail: { feeCoin: 'USDT', totalFee: '-0.05' },
        cTime: String(1704067200000 + i),
      });
    }
    const seenCursors: Array<string | null> = [];
    let fillsCalls = 0;
    const fetchHook = queueFetch((url) => {
      if (url.includes('/api/v2/spot/trade/fills')) {
        fillsCalls += 1;
        const u = new URL(url);
        seenCursors.push(u.searchParams.get('idLessThan'));
        if (fillsCalls === 1) {
          return { body: { code: '00000', msg: 'ok', data: page1 } };
        }
        return { body: { code: '00000', msg: 'ok', data: [] } };
      }
      if (
        url.includes('/api/v2/spot/wallet/deposit-records') ||
        url.includes('/api/v2/spot/wallet/withdrawal-records')
      ) {
        return { body: { code: '00000', msg: 'ok', data: [] } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      expect(events).toHaveLength(100);
      expect(fillsCalls).toBe(2);
      expect(seenCursors[0]).toBeNull(); // first page: no cursor
      expect(seenCursors[1]).toBe('trade-901'); // smallest tradeId from page1
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions maps deposits using tradeId as txid', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date('2024-01-05T00:00:00Z');

    const fetchHook = queueFetch((url) => {
      if (url.includes('/api/v2/spot/trade/fills')) {
        return { body: { code: '00000', msg: 'ok', data: [] } };
      }
      if (url.includes('/api/v2/spot/wallet/deposit-records')) {
        return {
          body: {
            code: '00000',
            msg: 'ok',
            data: [
              {
                orderId: 'dep-1',
                tradeId: '0xabc',
                coin: 'USDT',
                size: '1000',
                status: 'success',
                cTime: '1704067200000',
                uTime: '1704067200000',
              },
              {
                orderId: 'dep-2',
                coin: 'BTC',
                size: '0.5',
                status: 'success',
                cTime: '1704153600000',
              },
            ],
          },
        };
      }
      if (url.includes('/api/v2/spot/wallet/withdrawal-records')) {
        return { body: { code: '00000', msg: 'ok', data: [] } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      expect(events).toHaveLength(2);

      const withTxid = events.find((e) => e.externalId === '0xabc');
      expect(withTxid?.kind).toBe('deposit');
      expect(withTxid?.primary.tokenIdentity.symbol).toBe('USDT');
      expect(withTxid?.primary.quantity).toBe('1000'); // inflow

      const fallback = events.find((e) => e.externalId === 'deposit-dep-2');
      expect(fallback?.kind).toBe('deposit');
      expect(fallback?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(fallback?.primary.quantity).toBe('0.5');
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions maps withdrawals with fee + signed quantity', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const since = new Date('2024-01-01T00:00:00Z');
    const until = new Date('2024-01-05T00:00:00Z');

    const fetchHook = queueFetch((url) => {
      if (url.includes('/api/v2/spot/trade/fills')) {
        return { body: { code: '00000', msg: 'ok', data: [] } };
      }
      if (url.includes('/api/v2/spot/wallet/deposit-records')) {
        return { body: { code: '00000', msg: 'ok', data: [] } };
      }
      if (url.includes('/api/v2/spot/wallet/withdrawal-records')) {
        return {
          body: {
            code: '00000',
            msg: 'ok',
            data: [
              {
                orderId: 'wd-1',
                tradeId: '0xdef',
                coin: 'BTC',
                size: '0.05',
                fee: '0.0005',
                chain: 'bitcoin',
                toAddress: '...',
                status: 'success',
                cTime: '1704067200000',
                uTime: '1704067200000',
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      expect(events).toHaveLength(1);
      const wd = events[0];
      expect(wd?.kind).toBe('withdraw');
      expect(wd?.externalId).toBe('wd-1');
      expect(wd?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(wd?.primary.quantity).toBe('-0.05'); // outflow
      expect(wd?.fee?.tokenIdentity.symbol).toBe('BTC');
      expect(wd?.fee?.quantity).toBe('-0.0005');
    } finally {
      fetchHook.restore();
    }
  });

  test('fetchTransactions surfaces non-success Bitget envelope as ProviderError', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const fetchHook = queueFetch(() => ({
      body: { code: '40001', msg: 'bad request', data: [] },
    }));
    try {
      await expect(p.fetchTransactions({ ...ctx } as never)).rejects.toThrow('Bitget code=40001');
    } finally {
      fetchHook.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Live test against production Bitget — opt-in via SCANI_LIVE=1.
// Requires SCANI_LIVE_BITGET_API_KEY / SCANI_LIVE_BITGET_API_SECRET /
// SCANI_LIVE_BITGET_PASSPHRASE for a READ-ONLY throwaway-account key.
// Bitget has no public sandbox, so this hits live with read-only creds.
// ---------------------------------------------------------------------------
const liveDescribe =
  process.env.SCANI_LIVE === '1' &&
  process.env.SCANI_LIVE_BITGET_API_KEY &&
  process.env.SCANI_LIVE_BITGET_API_SECRET &&
  process.env.SCANI_LIVE_BITGET_PASSPHRASE
    ? describe
    : describe.skip;

liveDescribe('BitgetProvider [live]', () => {
  test('fetchTransactions hits api.bitget.com without HTTP error', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const liveCtx = {
      ...ctx,
      resolveCredentials: async () => ({
        apiKey: process.env.SCANI_LIVE_BITGET_API_KEY!,
        apiSecret: process.env.SCANI_LIVE_BITGET_API_SECRET!,
        passphrase: process.env.SCANI_LIVE_BITGET_PASSPHRASE!,
      }),
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      until: new Date(),
    };
    const events = await p.fetchTransactions(liveCtx as never);
    expect(Array.isArray(events)).toBe(true);
  });
});
