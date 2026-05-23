import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { resetProvidersConfig } from '../../src/core/config';
import { mapOkxBillToEvent, OkxProvider } from '../../src/providers/okx';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'okx',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's', passphrase: 'p' }),
};

describe('OkxProvider', () => {
  beforeEach(() => {
    resetProvidersConfig();
    delete process.env.SCANI_TESTNET_OKX_SIMULATED;
  });
  afterEach(() => {
    resetProvidersConfig();
    delete process.env.SCANI_TESTNET_OKX_SIMULATED;
  });

  test('canFetchBalances gates on okx', () => {
    const p = new OkxProvider(passthroughLimiter());
    expect(p.canFetchBalances('okx')).toBe(true);
    expect(p.canFetchBalances('binance')).toBe(false);
  });

  test('canFetchTransactions gates on okx', () => {
    const p = new OkxProvider(passthroughLimiter());
    expect(p.canFetchTransactions('okx')).toBe(true);
    expect(p.canFetchTransactions('binance')).toBe(false);
  });

  test('capabilities advertise transactions', () => {
    const p = new OkxProvider(passthroughLimiter());
    expect(p.capabilities).toContain('transactions');
  });

  test('fetchBalances reads cashBal, drops zeros, uppercases symbol', async () => {
    const p = new OkxProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: '0',
          msg: '',
          data: [
            {
              totalEq: '1000',
              details: [
                { ccy: 'btc', cashBal: '0.5', eqUsd: '50' },
                { ccy: 'usdt', cashBal: '0', eqUsd: '0' },
              ],
            },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toHaveLength(1);
      expect(out[0]?.tokenIdentity.symbol).toBe('BTC');
      expect(out[0]?.balance).toBe('0.5');
      const meta = out[0]?.tokenIdentity.providerMetadata as { okx: { ccy: string } };
      expect(meta.okx.ccy).toBe('btc');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects missing passphrase', async () => {
    const p = new OkxProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'okx');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('passphrase');
  });

  test('validateCredentials returns true on success code', async () => {
    const p = new OkxProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: '0', msg: '' }), { status: 200 })) as typeof fetch;
    try {
      const r = await p.validateCredentials(
        { apiKey: 'k', apiSecret: 's', passphrase: 'p' },
        'okx'
      );
      expect(r.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials returns false on non-zero code', async () => {
    const p = new OkxProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: '50111', msg: 'Invalid OK-ACCESS-KEY' }), {
        status: 200,
      })) as typeof fetch;
    try {
      const r = await p.validateCredentials(
        { apiKey: 'k', apiSecret: 's', passphrase: 'p' },
        'okx'
      );
      expect(r.valid).toBe(false);
      expect(r.message).toContain('50111');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('demo-trading header injected when SCANI_TESTNET_OKX_SIMULATED=1', async () => {
    process.env.SCANI_TESTNET_OKX_SIMULATED = '1';
    resetProvidersConfig();
    const p = new OkxProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ code: '0', msg: '', data: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await p.fetchBalances(ctx as never);
      expect(capturedHeaders['x-simulated-trading']).toBe('1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('demo-trading header absent in production mode', async () => {
    const p = new OkxProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ code: '0', msg: '', data: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await p.fetchBalances(ctx as never);
      expect(capturedHeaders['x-simulated-trading']).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('OkxProvider.fetchTransactions', () => {
  beforeEach(() => {
    resetProvidersConfig();
    delete process.env.SCANI_TESTNET_OKX_SIMULATED;
  });
  afterEach(() => {
    resetProvidersConfig();
    delete process.env.SCANI_TESTNET_OKX_SIMULATED;
  });

  test('merges bills (trade+fee), deposits, and withdrawals into one feed', async () => {
    const p = new OkxProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url.includes('/api/v5/account/bills') && !url.includes('archive')) {
        return new Response(
          JSON.stringify({
            code: '0',
            msg: '',
            data: [
              {
                billId: 'b1',
                ts: '1700000000000',
                ccy: 'BTC',
                type: '2',
                subType: '1',
                balChg: '0.1',
                instId: 'BTC-USDT',
                instType: 'SPOT',
                fee: '-0.001',
                feeCcy: 'USDT',
                px: '50000',
              },
              {
                billId: 'b2',
                ts: '1700000001000',
                ccy: 'USDT',
                type: '8',
                subType: '0',
                balChg: '-0.5',
              },
              {
                billId: 'b3',
                ts: '1700000002000',
                ccy: 'BTC',
                type: '1',
                subType: '1',
                balChg: '0.5',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/v5/asset/deposit-history')) {
        return new Response(
          JSON.stringify({
            code: '0',
            msg: '',
            data: [
              {
                ccy: 'BTC',
                amt: '0.5',
                ts: '1700000003000',
                txId: '0xdeadbeef',
                depId: 'd1',
                state: '2',
                chain: 'BTC-Bitcoin',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/v5/asset/withdrawal-history')) {
        return new Response(
          JSON.stringify({
            code: '0',
            msg: '',
            data: [
              {
                ccy: 'ETH',
                amt: '1.0',
                ts: '1700000004000',
                txId: '0xfeed',
                wdId: 'w1',
                state: '2',
                chain: 'ETH-ERC20',
                fee: '0.001',
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      const out = await p.fetchTransactions(ctx as never);
      // bills → trade(b1) + fee(b2). type=1 from bills is intentionally
      // skipped — the dedicated /asset endpoints supply transfers
      // with on-chain txId.
      expect(out).toHaveLength(4);

      const trade = out.find((e) => e.externalId === 'b1');
      expect(trade?.kind).toBe('buy');
      expect(trade?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(trade?.primary.quantity).toBe('0.1');
      expect(trade?.counter?.tokenIdentity.symbol).toBe('USDT');
      expect(trade?.fee?.tokenIdentity.symbol).toBe('USDT');
      expect(trade?.fee?.quantity).toBe('-0.001');
      expect(trade?.priceNative?.value).toBe('50000');
      expect(trade?.priceNative?.quoteIdentity.symbol).toBe('USDT');

      const fee = out.find((e) => e.externalId === 'b2');
      expect(fee?.kind).toBe('fee');
      expect(fee?.primary.quantity).toBe('-0.5');

      const deposit = out.find((e) => e.externalId === 'dep:d1');
      expect(deposit?.kind).toBe('deposit');
      expect(deposit?.primary.tokenIdentity.symbol).toBe('BTC');
      expect(deposit?.primary.quantity).toBe('0.5');

      const withdraw = out.find((e) => e.externalId === 'wd:w1');
      expect(withdraw?.kind).toBe('withdraw');
      expect(withdraw?.primary.quantity).toBe('-1.0');
      expect(withdraw?.fee?.quantity).toBe('-0.001');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('uses bills-archive when since is older than 7 days', async () => {
    const p = new OkxProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    const callCounts = { bills: 0, archive: 0, dep: 0, wd: 0 };
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/api/v5/account/bills-archive')) {
        callCounts.archive += 1;
        return new Response(JSON.stringify({ code: '0', msg: '', data: [] }), { status: 200 });
      }
      if (url.includes('/api/v5/account/bills')) {
        callCounts.bills += 1;
        return new Response(JSON.stringify({ code: '0', msg: '', data: [] }), { status: 200 });
      }
      if (url.includes('/api/v5/asset/deposit-history')) {
        callCounts.dep += 1;
        return new Response(JSON.stringify({ code: '0', msg: '', data: [] }), { status: 200 });
      }
      if (url.includes('/api/v5/asset/withdrawal-history')) {
        callCounts.wd += 1;
        return new Response(JSON.stringify({ code: '0', msg: '', data: [] }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    try {
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await p.fetchTransactions({ ...ctx, since: monthAgo } as never);
      expect(callCounts.bills).toBeGreaterThanOrEqual(1);
      expect(callCounts.archive).toBeGreaterThanOrEqual(1);
      expect(callCounts.dep).toBeGreaterThanOrEqual(1);
      expect(callCounts.wd).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('skips bills-archive when since is within 7 days', async () => {
    const p = new OkxProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    const callCounts = { bills: 0, archive: 0 };
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/api/v5/account/bills-archive')) {
        callCounts.archive += 1;
      } else if (url.includes('/api/v5/account/bills')) {
        callCounts.bills += 1;
      }
      return new Response(JSON.stringify({ code: '0', msg: '', data: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await p.fetchTransactions({ ...ctx, since: dayAgo } as never);
      expect(callCounts.bills).toBeGreaterThanOrEqual(1);
      expect(callCounts.archive).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('mapOkxBillToEvent', () => {
  test('type=2 with positive balChg → buy', () => {
    const ev = mapOkxBillToEvent({
      billId: 'b1',
      ts: '1700000000000',
      ccy: 'BTC',
      type: '2',
      subType: '1',
      balChg: '0.1',
      instId: 'BTC-USDT',
    });
    expect(ev?.kind).toBe('buy');
    expect(ev?.primary.tokenIdentity.symbol).toBe('BTC');
    expect(ev?.counter?.tokenIdentity.symbol).toBe('USDT');
  });

  test('type=2 with negative balChg → sell', () => {
    const ev = mapOkxBillToEvent({
      billId: 'b2',
      ts: '1700000000000',
      ccy: 'BTC',
      type: '2',
      subType: '2',
      balChg: '-0.1',
      instId: 'BTC-USDT',
    });
    expect(ev?.kind).toBe('sell');
    expect(ev?.primary.quantity).toBe('-0.1');
  });

  test('type=8 → fee event', () => {
    const ev = mapOkxBillToEvent({
      billId: 'b3',
      ts: '1700000000000',
      ccy: 'USDT',
      type: '8',
      subType: '0',
      balChg: '-0.5',
    });
    expect(ev?.kind).toBe('fee');
    expect(ev?.primary.tokenIdentity.symbol).toBe('USDT');
  });

  test('type=1 subType=1 → deposit', () => {
    const ev = mapOkxBillToEvent({
      billId: 'b4',
      ts: '1700000000000',
      ccy: 'BTC',
      type: '1',
      subType: '1',
      balChg: '0.5',
    });
    expect(ev?.kind).toBe('deposit');
  });

  test('type=1 subType=2 → withdraw', () => {
    const ev = mapOkxBillToEvent({
      billId: 'b5',
      ts: '1700000000000',
      ccy: 'BTC',
      type: '1',
      subType: '2',
      balChg: '-0.5',
    });
    expect(ev?.kind).toBe('withdraw');
  });

  test('unknown type returns null', () => {
    const ev = mapOkxBillToEvent({
      billId: 'b6',
      ts: '1700000000000',
      ccy: 'BTC',
      type: '99',
      subType: '0',
      balChg: '0.1',
    });
    expect(ev).toBeNull();
  });
});

const LIVE = process.env.SCANI_LIVE === '1';
const live = LIVE ? describe : describe.skip;

live('OkxProvider live (demo mode)', () => {
  beforeEach(() => {
    process.env.SCANI_TESTNET_OKX_SIMULATED = '1';
    resetProvidersConfig();
  });
  afterEach(() => {
    delete process.env.SCANI_TESTNET_OKX_SIMULATED;
    resetProvidersConfig();
  });

  test('fetchBalances against demo OKX', async () => {
    const apiKey = process.env.SCANI_TESTNET_OKX_API_KEY;
    const apiSecret = process.env.SCANI_TESTNET_OKX_SECRET;
    const passphrase = process.env.SCANI_TESTNET_OKX_PASSPHRASE;
    if (!apiKey || !apiSecret || !passphrase) {
      throw new Error('SCANI_LIVE=1 requires SCANI_TESTNET_OKX_API_KEY / SECRET / PASSPHRASE');
    }
    const p = new OkxProvider(passthroughLimiter());
    const liveCtx = {
      institutionCode: 'okx',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'live', institutionId: 'live' },
      resolveCredentials: async () => ({ apiKey, apiSecret, passphrase }),
    };
    const balances = await p.fetchBalances(liveCtx as never);
    expect(Array.isArray(balances)).toBe(true);
  });

  test('fetchTransactions against demo OKX', async () => {
    const apiKey = process.env.SCANI_TESTNET_OKX_API_KEY;
    const apiSecret = process.env.SCANI_TESTNET_OKX_SECRET;
    const passphrase = process.env.SCANI_TESTNET_OKX_PASSPHRASE;
    if (!apiKey || !apiSecret || !passphrase) {
      throw new Error('SCANI_LIVE=1 requires SCANI_TESTNET_OKX_API_KEY / SECRET / PASSPHRASE');
    }
    const p = new OkxProvider(passthroughLimiter());
    const liveCtx = {
      institutionCode: 'okx',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'live', institutionId: 'live' },
      resolveCredentials: async () => ({ apiKey, apiSecret, passphrase }),
      since: new Date(Date.now() - 24 * 60 * 60 * 1000),
    };
    const events = await p.fetchTransactions(liveCtx as never);
    expect(Array.isArray(events)).toBe(true);
  });
});
