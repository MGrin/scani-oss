import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { BinanceProvider } from '../../src/providers/binance';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'binance',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
};

describe('BinanceProvider', () => {
  test('canFetchBalances gates on institutionCode', () => {
    const p = new BinanceProvider(passthroughLimiter());
    expect(p.canFetchBalances('binance')).toBe(true);
    expect(p.canFetchBalances('coinbase')).toBe(false);
  });

  test('fetchBalances merges spot + margin + funding and skips zero-balance rows', async () => {
    const p = new BinanceProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      calls += 1;
      if (url.includes('/api/v3/account')) {
        return new Response(
          JSON.stringify({
            balances: [
              { asset: 'BTC', free: '0.5', locked: '0' },
              { asset: 'USDT', free: '0', locked: '0' },
              { asset: 'ETH', free: '1', locked: '0.2' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/sapi/v1/margin/account')) {
        return new Response(
          JSON.stringify({
            userAssets: [
              { asset: 'BTC', free: '0.1', locked: '0' },
              { asset: 'USDT', free: '50', locked: '0' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/sapi/v1/asset/get-funding-asset')) {
        return new Response(
          JSON.stringify([
            // freeze + withdrawing legs are escrowed by an open P2P /
            // pending withdrawal — still the user's funds.
            {
              asset: 'USDT',
              free: '100',
              locked: '0',
              freeze: '500',
              withdrawing: '0',
            },
            { asset: 'BNB', free: '2', locked: '0', freeze: '0', withdrawing: '0' },
          ]),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      const out = await p.fetchBalances(ctx as never);
      expect(calls).toBe(3); // spot + margin + funding
      const byAsset = Object.fromEntries(out.map((h) => [h.tokenIdentity.symbol, h.balance]));
      expect(byAsset.BTC).toBe('0.6'); // 0.5 spot + 0.1 margin
      expect(byAsset.ETH).toBe('1.2'); // 1 + 0.2 (spot only)
      // 0 spot + 50 margin + 100 free + 500 freeze (funding) = 650.
      expect(byAsset.USDT).toBe('650');
      expect(byAsset.BNB).toBe('2'); // funding-only asset surfaces
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchBalances tolerates funding-wallet permission failure', async () => {
    const p = new BinanceProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/api/v3/account')) {
        return new Response(
          JSON.stringify({ balances: [{ asset: 'BTC', free: '0.5', locked: '0' }] }),
          { status: 200 }
        );
      }
      if (url.includes('/sapi/v1/margin/account')) {
        return new Response(JSON.stringify({ userAssets: [] }), { status: 200 });
      }
      if (url.includes('/sapi/v1/asset/get-funding-asset')) {
        return new Response('Forbidden', { status: 403 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      const out = await p.fetchBalances(ctx as never);
      // Funding-wallet 403 doesn't kill the sync — spot still flows.
      const byAsset = Object.fromEntries(out.map((h) => [h.tokenIdentity.symbol, h.balance]));
      expect(byAsset.BTC).toBe('0.5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials maps 401 to invalid (auth-failed via ProviderError catch)', async () => {
    const p = new BinanceProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    try {
      const result = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'binance');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('binance HTTP 401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials returns true on a 200 response', async () => {
    const p = new BinanceProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"balances":[]}', { status: 200 })) as typeof fetch;
    try {
      const result = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'binance');
      expect(result.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects wrong institution code', async () => {
    const p = new BinanceProvider(passthroughLimiter());
    const result = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'okx');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('Wrong institution');
  });

  test('validateCredentials rejects missing creds', async () => {
    const p = new BinanceProvider(passthroughLimiter());
    const result = await p.validateCredentials({}, 'binance');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('apiKey');
  });
});

describe('BinanceProvider.fetchTransactions', () => {
  test('fans out balances → trades → deposits → withdraws and maps signs', async () => {
    const p = new BinanceProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;

    const tradesByCall = new Map<string, unknown[]>();
    // BTCUSDT: one sell (size 0.5 BTC for 15000 USDT, fee 0.0005 BTC).
    tradesByCall.set('BTCUSDT-fromId=0', [
      {
        symbol: 'BTCUSDT',
        id: 100,
        orderId: 1,
        price: '30000.00',
        qty: '0.5',
        quoteQty: '15000',
        commission: '0.0005',
        commissionAsset: 'BTC',
        time: 1_700_000_000_000,
        isBuyer: false,
        isMaker: false,
      },
    ]);
    // After the last id (100) any cursor advance returns empty.
    tradesByCall.set('BTCUSDT-fromId=101', []);

    const depositsByCoin = new Map<string, unknown[]>();
    depositsByCoin.set('BTC', [
      {
        amount: '0.25',
        coin: 'BTC',
        network: 'BTC',
        status: 1,
        txId: 'depo-tx-1',
        insertTime: 1_690_000_000_000,
      },
    ]);
    depositsByCoin.set('USDT', []);

    const withdrawsByCoin = new Map<string, unknown[]>();
    withdrawsByCoin.set('BTC', []);
    withdrawsByCoin.set('USDT', [
      {
        id: 'w1',
        amount: '500',
        transactionFee: '1',
        coin: 'USDT',
        status: 6,
        txId: 'wtx-1',
        applyTime: 1_695_000_000_000,
      },
    ]);

    const calls: { kind: string; url: string }[] = [];

    globalThis.fetch = (async (url: string) => {
      const u = String(url);

      if (u.includes('/api/v3/account')) {
        return new Response(
          JSON.stringify({
            balances: [
              { asset: 'BTC', free: '0.5', locked: '0' },
              { asset: 'USDT', free: '100', locked: '0' },
              { asset: 'XRP', free: '0', locked: '0' },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('/sapi/v1/margin/account')) {
        return new Response(JSON.stringify({ userAssets: [] }), { status: 200 });
      }
      if (u.includes('/sapi/v1/asset/get-funding-asset')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.includes('/sapi/v1/c2c/orderMatch/listUserOrderHistory')) {
        return new Response(JSON.stringify({ code: '000000', data: [], success: true }), {
          status: 200,
        });
      }

      if (u.includes('/api/v3/myTrades')) {
        const symbolMatch = u.match(/[?&]symbol=([^&]+)/);
        const fromIdMatch = u.match(/[?&]fromId=(\d+)/);
        const symbol = symbolMatch?.[1] ?? '';
        const fromId = fromIdMatch?.[1] ?? '0';
        const key = `${symbol}-fromId=${fromId}`;
        calls.push({ kind: 'trade', url: key });
        const body = tradesByCall.get(key) ?? [];
        return new Response(JSON.stringify(body), { status: 200 });
      }

      if (u.includes('/sapi/v1/capital/deposit/hisrec')) {
        const coin = u.match(/[?&]coin=([^&]+)/)?.[1] ?? '';
        const startMs = Number(u.match(/[?&]startTime=(\d+)/)?.[1] ?? '0');
        const endMs = Number(u.match(/[?&]endTime=(\d+)/)?.[1] ?? '0');
        calls.push({ kind: 'deposit', url: coin });
        const filtered = (depositsByCoin.get(coin) ?? []).filter((d) => {
          const t = (d as { insertTime: number }).insertTime;
          return t >= startMs && t <= endMs;
        });
        return new Response(JSON.stringify(filtered), { status: 200 });
      }
      if (u.includes('/sapi/v1/capital/withdraw/history')) {
        const coin = u.match(/[?&]coin=([^&]+)/)?.[1] ?? '';
        const startMs = Number(u.match(/[?&]startTime=(\d+)/)?.[1] ?? '0');
        const endMs = Number(u.match(/[?&]endTime=(\d+)/)?.[1] ?? '0');
        calls.push({ kind: 'withdraw', url: coin });
        const filtered = (withdrawsByCoin.get(coin) ?? []).filter((w) => {
          const t = (w as { applyTime: number }).applyTime;
          return t >= startMs && t <= endMs;
        });
        return new Response(JSON.stringify(filtered), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as typeof fetch;

    try {
      const since = new Date('2023-01-01T00:00:00Z');
      const until = new Date('2024-01-01T00:00:00Z');
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);

      // We expect 1 trade, 1 deposit, 1 withdraw.
      expect(events.length).toBe(3);

      const trade = events.find((e) => e.kind === 'sell');
      expect(trade).toBeDefined();
      expect(trade?.externalId).toBe('BTCUSDT-100');
      // Sell ⇒ primary BTC is negative, counter USDT is positive.
      expect(trade?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(trade?.primary.quantity).toBe('-0.5');
      expect(trade?.counter?.tokenIdentity.symbol).toBe('USDT');
      expect(trade?.counter?.quantity).toBe('15000');
      // Fee always negative, in commissionAsset.
      expect(trade?.fee?.tokenIdentity.symbol).toBe('BTC');
      expect(trade?.fee?.quantity).toBe('-0.0005');

      const dep = events.find((e) => e.kind === 'deposit');
      expect(dep?.externalId).toBe('BTC-1690000000000-depo-tx-1');
      expect(dep?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(dep?.primary.quantity).toBe('0.25');

      const wd = events.find((e) => e.kind === 'withdraw');
      expect(wd?.externalId).toBe('USDT-1695000000000-wtx-1');
      expect(wd?.primary.tokenIdentity.symbol).toBe('USDT');
      expect(wd?.primary.quantity).toBe('-500');
      expect(wd?.fee?.quantity).toBe('-1');

      // fromId cursor advanced past the highest seen id (100 → 101) and
      // the subsequent empty page terminated pagination for BTCUSDT.
      const btcUsdtTradeCalls = calls.filter(
        (c) => c.kind === 'trade' && c.url.startsWith('BTCUSDT-')
      );
      expect(btcUsdtTradeCalls.map((c) => c.url)).toEqual([
        'BTCUSDT-fromId=0',
        'BTCUSDT-fromId=101',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('emits C2C BUY / SELL orders, drops non-COMPLETED, surfaces commission as fee', async () => {
    const p = new BinanceProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: string) => {
      const u = String(url);

      // Empty spot/margin/funding so the deposit/withdraw fan-out is a no-op.
      if (u.includes('/api/v3/account')) {
        return new Response(JSON.stringify({ balances: [] }), { status: 200 });
      }
      if (u.includes('/sapi/v1/margin/account')) {
        return new Response(JSON.stringify({ userAssets: [] }), { status: 200 });
      }
      if (u.includes('/sapi/v1/asset/get-funding-asset')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }

      if (u.includes('/sapi/v1/c2c/orderMatch/listUserOrderHistory')) {
        const tradeType = u.match(/[?&]tradeType=([^&]+)/)?.[1];
        const page = u.match(/[?&]page=(\d+)/)?.[1];
        const startMs = Number(u.match(/[?&]startTimestamp=(\d+)/)?.[1] ?? '0');
        const endMs = Number(u.match(/[?&]endTimestamp=(\d+)/)?.[1] ?? '0');
        if (page !== '1') {
          return new Response(JSON.stringify({ code: '000000', data: [], success: true }), {
            status: 200,
          });
        }
        const all: Array<Record<string, unknown>> = [];
        if (tradeType === 'BUY') {
          all.push(
            {
              orderNumber: 'p2p-buy-1',
              tradeType: 'BUY',
              asset: 'USDT',
              fiat: 'EUR',
              amount: '1500.00',
              totalPrice: '1380.00',
              unitPrice: '0.92',
              orderStatus: 'COMPLETED',
              createTime: 1_705_000_000_000,
              commission: '0',
            },
            {
              orderNumber: 'p2p-buy-cancelled',
              tradeType: 'BUY',
              asset: 'USDT',
              fiat: 'EUR',
              amount: '500',
              totalPrice: '460',
              orderStatus: 'CANCELLED',
              createTime: 1_705_100_000_000,
              commission: '0',
            }
          );
        }
        if (tradeType === 'SELL') {
          all.push({
            orderNumber: 'p2p-sell-1',
            tradeType: 'SELL',
            asset: 'BTC',
            fiat: 'USD',
            amount: '0.1',
            totalPrice: '5000.00',
            unitPrice: '50000',
            orderStatus: 'COMPLETED',
            createTime: 1_710_000_000_000,
            commission: '0.0001',
          });
        }
        const filtered = all.filter((o) => {
          const t = o.createTime as number;
          return t >= startMs && t <= endMs;
        });
        return new Response(JSON.stringify({ code: '000000', data: filtered, success: true }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as typeof fetch;

    try {
      const since = new Date('2023-12-01T00:00:00Z');
      const until = new Date('2024-04-01T00:00:00Z');
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);

      // Only the 2 COMPLETED orders flow through — the CANCELLED row is dropped.
      expect(events.length).toBe(2);

      const buy = events.find((e) => e.externalId === 'c2c-p2p-buy-1');
      expect(buy?.kind).toBe('buy');
      expect(buy?.primary.tokenIdentity.symbol).toBe('USDT');
      expect(buy?.primary.quantity).toBe('1500');
      expect(buy?.counter?.tokenIdentity.symbol).toBe('EUR');
      // BUY ⇒ crypto in (+), fiat out (−).
      expect(buy?.counter?.quantity).toBe('-1380');
      expect(buy?.fee).toBeUndefined(); // commission 0 → no fee event

      const sell = events.find((e) => e.externalId === 'c2c-p2p-sell-1');
      expect(sell?.kind).toBe('sell');
      expect(sell?.primary.tokenIdentity.symbol).toBe('BTC');
      // SELL ⇒ crypto out (−), fiat in (+).
      expect(sell?.primary.quantity).toBe('-0.1');
      expect(sell?.counter?.tokenIdentity.symbol).toBe('USD');
      expect(sell?.counter?.quantity).toBe('5000');
      // Commission is taken from the crypto leg.
      expect(sell?.fee?.tokenIdentity.symbol).toBe('BTC');
      expect(sell?.fee?.quantity).toBe('-0.0001');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('C2C 403 (no permission) keeps trades + deposits + withdraws flowing', async () => {
    const p = new BinanceProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/api/v3/account')) {
        return new Response(
          JSON.stringify({ balances: [{ asset: 'BTC', free: '0.5', locked: '0' }] }),
          { status: 200 }
        );
      }
      if (u.includes('/sapi/v1/margin/account')) {
        return new Response(JSON.stringify({ userAssets: [] }), { status: 200 });
      }
      if (u.includes('/sapi/v1/asset/get-funding-asset')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.includes('/api/v3/myTrades')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.includes('/sapi/v1/capital/deposit/hisrec')) {
        const startMs = Number(u.match(/[?&]startTime=(\d+)/)?.[1] ?? '0');
        const endMs = Number(u.match(/[?&]endTime=(\d+)/)?.[1] ?? '0');
        const insertTime = 1_700_000_000_000;
        const rows =
          insertTime >= startMs && insertTime <= endMs
            ? [
                {
                  amount: '0.5',
                  coin: 'BTC',
                  status: 1,
                  txId: 'd-1',
                  insertTime,
                },
              ]
            : [];
        return new Response(JSON.stringify(rows), { status: 200 });
      }
      if (u.includes('/sapi/v1/capital/withdraw/history')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.includes('/sapi/v1/c2c/orderMatch/listUserOrderHistory')) {
        return new Response('Forbidden', { status: 403 });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as typeof fetch;

    try {
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date('2023-09-01T00:00:00Z'),
        until: new Date('2024-01-01T00:00:00Z'),
      } as never);
      // C2C 403 should not abort the broader import — the deposit flows.
      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe('deposit');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Live integration test against the Binance Spot Testnet.
  //
  // Sandbox setup:
  //   1. Sign in at https://testnet.binance.vision/ with GitHub.
  //   2. Generate HMAC_SHA256 keys.
  //   3. Optionally place a small test trade in the testnet UI to seed myTrades.
  //   4. Export:
  //        SCANI_TESTNET_BINANCE_API_KEY=...
  //        SCANI_TESTNET_BINANCE_API_SECRET=...
  //        SCANI_TESTNET_BINANCE_BASE_URL=https://testnet.binance.vision  (default)
  //   5. Run: SCANI_LIVE=1 bun test packages/clients/providers/tests/providers/binance.test.ts
  //
  // Disabled in CI by the SCANI_LIVE gate.
  test.skipIf(process.env.SCANI_LIVE !== '1')(
    'live testnet returns an array shape',
    async () => {
      const apiKey = process.env.SCANI_TESTNET_BINANCE_API_KEY;
      const apiSecret = process.env.SCANI_TESTNET_BINANCE_API_SECRET;
      const baseUrl =
        process.env.SCANI_TESTNET_BINANCE_BASE_URL ?? 'https://testnet.binance.vision';
      if (!apiKey || !apiSecret) {
        throw new Error(
          'SCANI_LIVE=1 requires SCANI_TESTNET_BINANCE_API_KEY and SCANI_TESTNET_BINANCE_API_SECRET'
        );
      }
      const provider = new BinanceProvider(passthroughLimiter(), baseUrl);
      const events = await provider.fetchTransactions({
        institutionCode: 'binance',
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
