import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { MexcProvider } from '../../src/providers/mexc';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'mexc',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
};

describe('MexcProvider', () => {
  test('canFetchBalances gates on mexc', () => {
    const p = new MexcProvider(passthroughLimiter());
    expect(p.canFetchBalances('mexc')).toBe(true);
    expect(p.canFetchBalances('binance')).toBe(false);
  });

  test('canFetchTransactions gates on mexc', () => {
    const p = new MexcProvider(passthroughLimiter());
    expect(p.canFetchTransactions('mexc')).toBe(true);
    expect(p.canFetchTransactions('binance')).toBe(false);
  });

  test('fetchBalances sums free + locked, drops zeros, uppercases symbol', async () => {
    const p = new MexcProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          balances: [
            { asset: 'btc', free: '0.5', locked: '0.1' },
            { asset: 'usdt', free: '0', locked: '0' },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toHaveLength(1);
      expect(out[0]?.tokenIdentity.symbol).toBe('BTC');
      expect(out[0]?.balance).toBe('0.6');
      const meta = out[0]?.tokenIdentity.providerMetadata as { mexc: { asset: string } };
      expect(meta.mexc.asset).toBe('btc');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new MexcProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'binance');
    expect(r.valid).toBe(false);
  });

  test('validateCredentials returns true on 200', async () => {
    const p = new MexcProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ balances: [] }), { status: 200 })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'mexc');
      expect(r.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials maps 401 to invalid', async () => {
    const p = new MexcProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'mexc');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('mexc HTTP 401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('MexcProvider.fetchTransactions', () => {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

  test('fans out balances → trades → deposits → withdraws and maps signs', async () => {
    const p = new MexcProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;

    // BTCUSDT buy of 0.25 BTC for 7500 USDT, fee 0.0001 BTC.
    const btcUsdtBuy = {
      symbol: 'BTCUSDT',
      id: '900',
      orderId: '9',
      price: '30000',
      qty: '0.25',
      quoteQty: '7500',
      commission: '0.0001',
      commissionAsset: 'BTC',
      time: 1_700_000_000_000,
      isBuyer: true,
      isMaker: false,
    };

    globalThis.fetch = (async (url: string) => {
      const u = String(url);

      if (u.includes('/api/v3/account')) {
        return new Response(
          JSON.stringify({
            balances: [
              { asset: 'BTC', free: '0.5', locked: '0' },
              { asset: 'USDT', free: '100', locked: '0' },
            ],
          }),
          { status: 200 }
        );
      }

      if (u.includes('/api/v3/myTrades')) {
        const symbol = u.match(/[?&]symbol=([^&]+)/)?.[1] ?? '';
        const startTime = Number(u.match(/[?&]startTime=(\d+)/)?.[1] ?? '0');
        const endTime = Number(u.match(/[?&]endTime=(\d+)/)?.[1] ?? '0');
        // Only return the trade once, in the window that contains its
        // timestamp, so we don't double-count across overlapping windows.
        const inWindow =
          symbol === 'BTCUSDT' &&
          btcUsdtBuy.time >= startTime &&
          btcUsdtBuy.time <= endTime &&
          !u.includes('fromId');
        return new Response(JSON.stringify(inWindow ? [btcUsdtBuy] : []), { status: 200 });
      }

      if (u.includes('/api/v3/capital/deposit/hisrec')) {
        const coin = u.match(/[?&]coin=([^&]+)/)?.[1] ?? '';
        const startTime = Number(u.match(/[?&]startTime=(\d+)/)?.[1] ?? '0');
        const endTime = Number(u.match(/[?&]endTime=(\d+)/)?.[1] ?? '0');
        if (coin !== 'BTC') return new Response('[]', { status: 200 });
        const dep = {
          amount: '0.1',
          coin: 'BTC',
          status: 1,
          txId: 'depo-1',
          insertTime: 1_695_000_000_000,
        };
        const inWindow = dep.insertTime >= startTime && dep.insertTime <= endTime;
        return new Response(JSON.stringify(inWindow ? [dep] : []), { status: 200 });
      }

      if (u.includes('/api/v3/capital/withdraw/history')) {
        const coin = u.match(/[?&]coin=([^&]+)/)?.[1] ?? '';
        const startTime = Number(u.match(/[?&]startTime=(\d+)/)?.[1] ?? '0');
        const endTime = Number(u.match(/[?&]endTime=(\d+)/)?.[1] ?? '0');
        if (coin !== 'USDT') return new Response('[]', { status: 200 });
        const wd = {
          id: 'w1',
          amount: '50',
          transactionFee: '1',
          coin: 'USDT',
          status: 6,
          txId: 'wtx-1',
          applyTime: 1_697_000_000_000,
        };
        const inWindow = wd.applyTime >= startTime && wd.applyTime <= endTime;
        return new Response(JSON.stringify(inWindow ? [wd] : []), { status: 200 });
      }

      throw new Error(`Unexpected URL: ${u}`);
    }) as typeof fetch;

    try {
      const since = new Date('2023-01-01T00:00:00Z');
      const until = new Date('2024-01-01T00:00:00Z');
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);

      expect(events.length).toBe(3);

      const buy = events.find((e) => e.kind === 'buy');
      expect(buy).toBeDefined();
      expect(buy?.externalId).toBe('BTCUSDT-900');
      expect(buy?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(buy?.primary.quantity).toBe('0.25');
      expect(buy?.counter?.tokenIdentity.symbol).toBe('USDT');
      expect(buy?.counter?.quantity).toBe('-7500');
      expect(buy?.fee?.tokenIdentity.symbol).toBe('BTC');
      expect(buy?.fee?.quantity).toBe('-0.0001');

      const dep = events.find((e) => e.kind === 'deposit');
      expect(dep?.externalId).toBe('BTC-1695000000000-depo-1');
      expect(dep?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(dep?.primary.quantity).toBe('0.1');

      const wd = events.find((e) => e.kind === 'withdraw');
      expect(wd?.externalId).toBe('USDT-1697000000000-wtx-1');
      expect(wd?.primary.tokenIdentity.symbol).toBe('USDT');
      expect(wd?.primary.quantity).toBe('-50');
      expect(wd?.fee?.quantity).toBe('-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('myTrades walks 30-day windows across the requested range', async () => {
    const p = new MexcProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    const tradeWindows: Array<{ startTime: number; endTime: number }> = [];

    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/api/v3/account')) {
        return new Response(
          JSON.stringify({ balances: [{ asset: 'BTC', free: '0.5', locked: '0' }] }),
          { status: 200 }
        );
      }
      if (u.includes('/api/v3/myTrades')) {
        const startTime = Number(u.match(/[?&]startTime=(\d+)/)?.[1] ?? '0');
        const endTime = Number(u.match(/[?&]endTime=(\d+)/)?.[1] ?? '0');
        tradeWindows.push({ startTime, endTime });
        return new Response('[]', { status: 200 });
      }
      // Capital endpoints aren't the focus here — return empty.
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    try {
      // 95-day range → ⌈95/30⌉ = 4 windows per symbol.
      const until = new Date('2024-04-05T00:00:00Z');
      const since = new Date(until.getTime() - 95 * 24 * 60 * 60 * 1000);
      await p.fetchTransactions({ ...ctx, since, until } as never);

      // BTC holding produces only reverse-quote candidates? With BTC as
      // the sole base asset and TX_QUOTE_ASSETS containing BTC, we expect
      // BTC×{everything except BTC} = 8 candidate symbols.
      // Each symbol issues 4 windowed trade calls.
      expect(tradeWindows.length).toBe(8 * 4);

      // First window must start exactly at `since`; final window must
      // end exactly at `until`. Each interior window spans 30 days.
      const firstSymbolWindows = tradeWindows.slice(0, 4);
      expect(firstSymbolWindows[0]?.startTime).toBe(since.getTime());
      expect(firstSymbolWindows[3]?.endTime).toBe(until.getTime());
      for (let i = 0; i < 3; i++) {
        const span =
          (firstSymbolWindows[i]?.endTime ?? 0) - (firstSymbolWindows[i]?.startTime ?? 0);
        expect(span).toBe(THIRTY_DAYS_MS);
        // Adjacent windows must butt up.
        expect(firstSymbolWindows[i + 1]?.startTime).toBe(firstSymbolWindows[i]?.endTime);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('myTrades advances fromId cursor when a window page fills', async () => {
    const p = new MexcProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;

    // Build a single full-page response (1000 trades, ids 1..1000) so
    // the loop has to advance fromId to the next page.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      symbol: 'BTCUSDT',
      id: String(i + 1),
      orderId: '0',
      price: '1',
      qty: '0',
      quoteQty: '0',
      commission: '0',
      commissionAsset: 'BTC',
      time: 1_700_000_000_000,
      isBuyer: true,
      isMaker: false,
    }));

    const tradeCalls: Array<{ symbol: string; fromId?: string }> = [];

    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/api/v3/account')) {
        return new Response(
          JSON.stringify({ balances: [{ asset: 'BTC', free: '1', locked: '0' }] }),
          { status: 200 }
        );
      }
      if (u.includes('/api/v3/myTrades')) {
        const symbol = u.match(/[?&]symbol=([^&]+)/)?.[1] ?? '';
        const fromIdMatch = u.match(/[?&]fromId=(\d+)/);
        const fromId = fromIdMatch?.[1];
        tradeCalls.push({ symbol, fromId });
        if (symbol !== 'BTCUSDT') return new Response('[]', { status: 200 });
        // First page (no fromId) returns full page; subsequent pages empty.
        if (fromId === undefined) return new Response(JSON.stringify(fullPage), { status: 200 });
        return new Response('[]', { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    try {
      // Single 30-day window so we only see the cursor walk once.
      const until = new Date('2024-01-31T00:00:00Z');
      const since = new Date(until.getTime() - THIRTY_DAYS_MS);
      await p.fetchTransactions({ ...ctx, since, until } as never);

      const btcUsdtCalls = tradeCalls.filter((c) => c.symbol === 'BTCUSDT');
      // First call has no fromId, second call has fromId=1001 (1000 + 1),
      // third call (empty page) terminates the loop.
      expect(btcUsdtCalls.map((c) => c.fromId)).toEqual([undefined, '1001']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('deposits + withdrawals walk in 90-day windows', async () => {
    const p = new MexcProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    const depositWindows: Array<{ coin: string; startTime: number; endTime: number }> = [];
    const withdrawWindows: Array<{ coin: string; startTime: number; endTime: number }> = [];

    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/api/v3/account')) {
        return new Response(
          JSON.stringify({ balances: [{ asset: 'BTC', free: '0.5', locked: '0' }] }),
          { status: 200 }
        );
      }
      if (u.includes('/api/v3/myTrades')) {
        return new Response('[]', { status: 200 });
      }
      if (u.includes('/api/v3/capital/deposit/hisrec')) {
        const coin = u.match(/[?&]coin=([^&]+)/)?.[1] ?? '';
        const startTime = Number(u.match(/[?&]startTime=(\d+)/)?.[1] ?? '0');
        const endTime = Number(u.match(/[?&]endTime=(\d+)/)?.[1] ?? '0');
        depositWindows.push({ coin, startTime, endTime });
        return new Response('[]', { status: 200 });
      }
      if (u.includes('/api/v3/capital/withdraw/history')) {
        const coin = u.match(/[?&]coin=([^&]+)/)?.[1] ?? '';
        const startTime = Number(u.match(/[?&]startTime=(\d+)/)?.[1] ?? '0');
        const endTime = Number(u.match(/[?&]endTime=(\d+)/)?.[1] ?? '0');
        withdrawWindows.push({ coin, startTime, endTime });
        return new Response('[]', { status: 200 });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as typeof fetch;

    try {
      // 200-day range → ⌈200/90⌉ = 3 windows per asset (90 + 90 + 20).
      const until = new Date('2024-08-01T00:00:00Z');
      const since = new Date(until.getTime() - 200 * 24 * 60 * 60 * 1000);
      await p.fetchTransactions({ ...ctx, since, until } as never);

      // Single held asset (BTC) → 3 deposit windows + 3 withdraw windows.
      expect(depositWindows.length).toBe(3);
      expect(withdrawWindows.length).toBe(3);
      expect(depositWindows[0]?.coin).toBe('BTC');
      expect(depositWindows[0]?.startTime).toBe(since.getTime());
      expect(depositWindows[2]?.endTime).toBe(until.getTime());
      expect((depositWindows[0]?.endTime ?? 0) - (depositWindows[0]?.startTime ?? 0)).toBe(
        NINETY_DAYS_MS
      );
      expect((depositWindows[1]?.endTime ?? 0) - (depositWindows[1]?.startTime ?? 0)).toBe(
        NINETY_DAYS_MS
      );
      // Final partial window (200 - 180 = 20 days).
      expect((depositWindows[2]?.endTime ?? 0) - (depositWindows[2]?.startTime ?? 0)).toBe(
        20 * 24 * 60 * 60 * 1000
      );

      // Withdraws follow the same partition.
      expect(withdrawWindows[0]?.startTime).toBe(since.getTime());
      expect(withdrawWindows[2]?.endTime).toBe(until.getTime());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Live integration test against MEXC production with READ-ONLY keys.
  // No sandbox is offered by MEXC — provide a key scoped to read-only.
  //
  // Setup:
  //   1. Generate read-only API keys at https://www.mexc.com/user/openapi
  //   2. Export:
  //        SCANI_LIVE_MEXC_API_KEY=...
  //        SCANI_LIVE_MEXC_API_SECRET=...
  //   3. Run: SCANI_LIVE=1 bun test packages/clients/providers/tests/providers/mexc.test.ts
  //
  // Disabled in CI by the SCANI_LIVE gate.
  test.skipIf(process.env.SCANI_LIVE !== '1')(
    'live production returns an array shape',
    async () => {
      const apiKey = process.env.SCANI_LIVE_MEXC_API_KEY;
      const apiSecret = process.env.SCANI_LIVE_MEXC_API_SECRET;
      if (!apiKey || !apiSecret) {
        throw new Error(
          'SCANI_LIVE=1 requires SCANI_LIVE_MEXC_API_KEY and SCANI_LIVE_MEXC_API_SECRET'
        );
      }
      const provider = new MexcProvider(passthroughLimiter());
      const events = await provider.fetchTransactions({
        institutionCode: 'mexc',
        baseCurrency: { id: 'usd', symbol: 'USD' } as never,
        credentialsRef: { userId: 'live', institutionId: 'live' },
        resolveCredentials: async () => ({ apiKey, apiSecret }),
        since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        until: new Date(),
      });
      expect(Array.isArray(events)).toBe(true);
    },
    60_000
  );
});
