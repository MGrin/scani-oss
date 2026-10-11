import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { BitgetProvider } from '../../src/providers/bitget';

// SC-1576: a unified-trading-account (UTA) key cannot call Bitget's classic
// V2 endpoints, and Bitget has migrated classic accounts to UTA since
// 2026-09-15. Shapes follow ccxt's bitget.ts samples (Bitget's docs are not
// reachable from this machine).

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

type Handler = (url: URL) => { body: unknown; status?: number };

function stubFetch(handler: Handler): { restore: () => void; calls: URL[] } {
  const original = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    calls.push(url);
    const r = handler(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

const ok = (data: unknown) => ({ body: { code: '00000', msg: 'success', data } });
// What a UTA key gets from a classic endpoint, and a classic key from a UTA one.
const refused = { body: { code: '40084', msg: 'not supported for this account' }, status: 400 };

describe('BitgetProvider on a unified trading account (SC-1576)', () => {
  test('fetchBalances reads the unified and funding assets, summed per coin', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const hook = stubFetch((u) => {
      if (u.pathname === '/api/v3/account/settings') return ok({});
      if (u.pathname === '/api/v3/account/assets')
        return ok({
          assets: [
            { coin: 'BTC', balance: '0.5', available: '0.4', locked: '0.1', debt: '0' },
            { coin: 'ETH', balance: '0', available: '0', locked: '0', debt: '0' },
          ],
        });
      if (u.pathname === '/api/v3/account/funding-assets')
        return ok([
          { coin: 'BTC', balance: '0.25', available: '0.25', frozen: '0' },
          { coin: 'USDT', balance: '12', available: '12', frozen: '0' },
        ]);
      return refused;
    });
    try {
      const out = await p.fetchBalances(ctx as never);
      const byCoin = Object.fromEntries(out.map((h) => [h.externalId, h.balance]));
      expect(byCoin).toEqual({ BTC: '0.75', USDT: '12' });
      expect(hook.calls.some((u) => u.pathname.startsWith('/api/v2/'))).toBe(false);
    } finally {
      hook.restore();
    }
  });

  test('fetchTransactions maps spot fills, deposits and withdrawals from the V3 feeds', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const since = new Date('2026-09-20T00:00:00Z');
    const until = new Date('2026-09-25T00:00:00Z');
    const t = String(Date.parse('2026-09-21T00:00:00Z'));
    const hook = stubFetch((u) => {
      if (u.pathname === '/api/v3/account/settings') return ok({});
      if (u.pathname === '/api/v3/trade/fills')
        return ok({
          list: [
            {
              execId: 'exec-1',
              orderId: 'ord-1',
              category: 'SPOT',
              symbol: 'BTCUSDT',
              side: 'buy',
              execPrice: '60000',
              execQty: '0.5',
              execValue: '30000',
              feeDetail: [{ feeCoin: 'BTC', fee: '0.01' }],
              createdTime: t,
            },
            {
              execId: 'exec-futures',
              orderId: 'ord-2',
              category: 'USDT-FUTURES',
              symbol: 'BTCUSDT',
              side: 'sell',
              execPrice: '60000',
              execQty: '1',
              execValue: '60000',
              feeDetail: [{ feeCoin: 'USDT', fee: '6' }],
              createdTime: t,
            },
          ],
          cursor: '',
        });
      if (u.pathname === '/api/v3/account/deposit-records')
        return ok([
          {
            orderId: 'dep-1',
            recordId: 'tx-dep-1',
            coin: 'USDT',
            type: 'deposit',
            size: '30',
            status: 'success',
            createdTime: t,
            updatedTime: t,
          },
        ]);
      if (u.pathname === '/api/v3/account/withdrawal-records')
        return ok([
          {
            orderId: 'wd-1',
            recordId: 'tx-wd-1',
            coin: 'USDT',
            type: 'withdraw',
            size: '20',
            fee: '-1.5',
            status: 'success',
            createdTime: t,
            updatedTime: t,
          },
        ]);
      return refused;
    });
    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      expect(events.map((e) => `${e.kind}:${e.externalId}`).sort()).toEqual([
        'buy:exec-1',
        'deposit:tx-dep-1',
        'withdraw:wd-1',
      ]);
      const buy = events.find((e) => e.externalId === 'exec-1');
      expect(buy?.primary.quantity).toBe('0.5');
      expect(buy?.counter?.quantity).toBe('-30000');
      expect(buy?.fee?.quantity).toBe('-0.01');
      expect(buy?.occurredAt.toISOString()).toBe('2026-09-21T00:00:00.000Z');
      const wd = events.find((e) => e.kind === 'withdraw');
      expect(wd?.primary.quantity).toBe('-20');
      expect(wd?.fee?.quantity).toBe('-1.5');
      const fills = hook.calls.filter((u) => u.pathname === '/api/v3/trade/fills');
      expect(fills.every((u) => u.searchParams.get('category') === 'SPOT')).toBe(true);
      expect(hook.calls.some((u) => u.pathname.startsWith('/api/v2/'))).toBe(false);
    } finally {
      hook.restore();
    }
  });

  test('V3 feeds page by cursor', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const since = new Date('2026-09-20T00:00:00Z');
    const until = new Date('2026-09-25T00:00:00Z');
    const t = String(Date.parse('2026-09-21T00:00:00Z'));
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      execId: `e-${i}`,
      orderId: `o-${i}`,
      category: 'SPOT',
      symbol: 'BTCUSDT',
      side: 'buy',
      execPrice: '1',
      execQty: '1',
      execValue: '1',
      feeDetail: [],
      createdTime: t,
    }));
    const hook = stubFetch((u) => {
      if (u.pathname === '/api/v3/account/settings') return ok({});
      if (u.pathname === '/api/v3/trade/fills') {
        if (!u.searchParams.get('cursor')) return ok({ list: fullPage, cursor: 'next-1' });
        return ok({ list: [], cursor: '' });
      }
      if (u.pathname.endsWith('-records')) return ok([]);
      return refused;
    });
    try {
      const events = await p.fetchTransactions({ ...ctx, since, until } as never);
      expect(events).toHaveLength(100);
      const fills = hook.calls.filter((u) => u.pathname === '/api/v3/trade/fills');
      expect(fills.map((u) => u.searchParams.get('cursor'))).toEqual([null, 'next-1']);
    } finally {
      hook.restore();
    }
  });

  test('V3 feeds are queried in windows of at most 30 days', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const until = new Date('2026-09-30T00:00:00Z');
    const since = new Date(until.getTime() - 70 * 24 * 60 * 60 * 1000);
    const hook = stubFetch((u) => {
      if (u.pathname === '/api/v3/account/settings') return ok({});
      if (u.pathname === '/api/v3/trade/fills') return ok({ list: [], cursor: '' });
      if (u.pathname.endsWith('-records')) return ok([]);
      return refused;
    });
    try {
      await p.fetchTransactions({ ...ctx, since, until } as never);
      const deposits = hook.calls.filter((u) => u.pathname === '/api/v3/account/deposit-records');
      expect(deposits).toHaveLength(3);
      for (const u of deposits) {
        const span =
          Number(u.searchParams.get('endTime')) - Number(u.searchParams.get('startTime'));
        expect(span).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
      }
      expect(Number(deposits[0]?.searchParams.get('startTime'))).toBe(since.getTime());
      expect(Number(deposits.at(-1)?.searchParams.get('endTime'))).toBe(until.getTime());
    } finally {
      hook.restore();
    }
  });

  test('validateCredentials accepts a unified key the classic endpoint refuses', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const hook = stubFetch((u) => {
      if (u.pathname === '/api/v3/account/settings') return ok({});
      return refused;
    });
    try {
      const r = await p.validateCredentials(
        { apiKey: 'k', apiSecret: 's', passphrase: 'p' },
        'bitget'
      );
      expect(r.valid).toBe(true);
    } finally {
      hook.restore();
    }
  });

  test('control: a classic account still reads V2 and makes no other V3 call', async () => {
    const p = new BitgetProvider(passthroughLimiter());
    const hook = stubFetch((u) => {
      if (u.pathname === '/api/v2/spot/account/assets')
        return ok([{ coin: 'BTC', available: '1', frozen: '0', locked: '0' }]);
      return refused;
    });
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out.map((h) => [h.externalId, h.balance])).toEqual([['BTC', '1']]);
      const v3 = hook.calls.filter((u) => u.pathname.startsWith('/api/v3/'));
      expect(v3.map((u) => u.pathname)).toEqual(['/api/v3/account/settings']);
    } finally {
      hook.restore();
    }
  });
});
