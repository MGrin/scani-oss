import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { BitstampProvider, userTransactionToEvent } from '../../src/providers/bitstamp';
import { resolvePair, resolveSingleAsset } from '../../src/providers/bitstamp/pair-resolver';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'bitstamp',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
};

describe('BitstampProvider', () => {
  test('canFetchBalances gates on bitstamp', () => {
    const p = new BitstampProvider(passthroughLimiter());
    expect(p.canFetchBalances('bitstamp')).toBe(true);
    expect(p.canFetchBalances('binance')).toBe(false);
  });

  test('canFetchTransactions gates on bitstamp', () => {
    const p = new BitstampProvider(passthroughLimiter());
    expect(p.canFetchTransactions('bitstamp')).toBe(true);
    expect(p.canFetchTransactions('binance')).toBe(false);
  });

  test('capabilities advertise transactions', () => {
    const p = new BitstampProvider(passthroughLimiter());
    expect(p.capabilities).toContain('transactions');
  });

  test('fetchBalances parses *_balance keys, uppercases symbol, skips zeros', async () => {
    const p = new BitstampProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          btc_balance: '0.25',
          usd_balance: '0',
          eur_balance: '100',
          btc_available: '0.25', // not a *_balance key
        }),
        { status: 200 }
      )) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      const symbols = out.map((h) => h.tokenIdentity.symbol).sort();
      expect(symbols).toEqual(['BTC', 'EUR']);
      const btc = out.find((h) => h.tokenIdentity.symbol === 'BTC');
      expect(btc?.balance).toBe('0.25');
      const meta = btc?.tokenIdentity.providerMetadata as { bitstamp: { currency: string } };
      expect(meta.bitstamp.currency).toBe('btc');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new BitstampProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'okx');
    expect(r.valid).toBe(false);
  });

  test('validateCredentials returns true on 200', async () => {
    const p = new BitstampProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'bitstamp');
      expect(r.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials maps 401 to invalid', async () => {
    const p = new BitstampProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'bitstamp');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('bitstamp HTTP 401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('resolvePair / resolveSingleAsset', () => {
  test('resolvePair detects btc/usd from a market-trade row', () => {
    const row = {
      id: 1,
      datetime: '2024-01-15 10:30:45.000000',
      type: '2',
      btc: '-0.1',
      usd: '5000.00',
      btc_usd: '50000.00',
      fee: '10.00',
      order_id: 99,
    };
    expect(resolvePair(row)).toEqual({ base: 'btc', quote: 'usd', priceKey: 'btc_usd' });
  });

  test('resolvePair detects eth/eur from a market-trade row', () => {
    const row = {
      id: 2,
      datetime: '2024-01-15 11:30:45.000000',
      type: '2',
      eth: '1.0',
      eur: '-2500.00',
      eth_eur: '2500.00',
      fee: '5.00',
    };
    expect(resolvePair(row)).toEqual({ base: 'eth', quote: 'eur', priceKey: 'eth_eur' });
  });

  test('resolvePair returns null for a non-trade row', () => {
    const row = {
      id: 3,
      datetime: '2024-01-15 12:00:00.000000',
      type: '0',
      btc: '0.5',
      fee: '0.00',
    };
    expect(resolvePair(row)).toBeNull();
  });

  test('resolvePair ignores eur_usd_rate sidecar key', () => {
    const row = {
      id: 4,
      datetime: '2024-01-15 13:00:00.000000',
      type: '2',
      btc: '0.1',
      usd: '-5000',
      btc_usd: '50000',
      eur_usd_rate: '1.08',
      fee: '5.00',
    };
    expect(resolvePair(row)).toEqual({ base: 'btc', quote: 'usd', priceKey: 'btc_usd' });
  });

  test('resolveSingleAsset returns the lone non-zero key', () => {
    const row = {
      id: 5,
      datetime: '2024-01-15 14:00:00.000000',
      type: '0',
      btc: '0.5',
      fee: '0.00',
    };
    expect(resolveSingleAsset(row)).toBe('btc');
  });

  test('resolveSingleAsset returns null when multiple non-zero keys present', () => {
    const row = {
      id: 6,
      datetime: '2024-01-15 14:00:00.000000',
      type: '2',
      btc: '0.1',
      usd: '-5000',
      btc_usd: '50000',
      fee: '5.00',
    };
    expect(resolveSingleAsset(row)).toBeNull();
  });
});

describe('userTransactionToEvent', () => {
  test('type=0 deposit with single asset key → deposit event', () => {
    const ev = userTransactionToEvent({
      id: 100,
      datetime: '2024-01-15 10:00:00.000000',
      type: '0',
      btc: '0.5',
      fee: '0.00',
    });
    expect(ev?.kind).toBe('deposit');
    expect(ev?.primary.tokenIdentity.symbol).toBe('BTC');
    expect(ev?.primary.quantity).toBe('0.5');
    expect(ev?.externalId).toBe('user-tx:100');
  });

  test('type=1 withdrawal forces negative sign on primary', () => {
    const ev = userTransactionToEvent({
      id: 101,
      datetime: '2024-01-15 10:01:00.000000',
      type: '1',
      eur: '50.00',
      fee: '0.00',
    });
    expect(ev?.kind).toBe('withdraw');
    expect(ev?.primary.quantity).toBe('-50');
    expect(ev?.primary.tokenIdentity.symbol).toBe('EUR');
  });

  test('type=2 with negative base → sell, fee in quote', () => {
    const ev = userTransactionToEvent({
      id: 102,
      datetime: '2024-01-15 10:02:00.000000',
      type: '2',
      btc: '-0.1',
      usd: '5000.00',
      btc_usd: '50000.00',
      fee: '10.00',
      order_id: 7,
    });
    expect(ev?.kind).toBe('sell');
    expect(ev?.primary.tokenIdentity.symbol).toBe('BTC');
    expect(ev?.primary.quantity).toBe('-0.1');
    expect(ev?.counter?.tokenIdentity.symbol).toBe('USD');
    expect(ev?.counter?.quantity).toBe('5000');
    expect(ev?.priceNative?.value).toBe('50000');
    expect(ev?.priceNative?.quoteIdentity.symbol).toBe('USD');
    expect(ev?.fee?.quantity).toBe('-10');
    expect(ev?.fee?.tokenIdentity.symbol).toBe('USD');
  });

  test('type=2 with positive base → buy, counter sign inverted', () => {
    const ev = userTransactionToEvent({
      id: 103,
      datetime: '2024-01-15 10:03:00.000000',
      type: '2',
      eth: '2.0',
      usd: '-4000.00',
      eth_usd: '2000.00',
      fee: '8.00',
    });
    expect(ev?.kind).toBe('buy');
    expect(ev?.primary.quantity).toBe('2');
    expect(ev?.counter?.quantity).toBe('-4000');
    expect(ev?.priceNative?.value).toBe('2000');
  });

  test('type=14 sub-account transfer → transfer_in / transfer_out by sign', () => {
    const out = userTransactionToEvent({
      id: 104,
      datetime: '2024-01-15 10:04:00.000000',
      type: '14',
      btc: '-0.25',
      fee: '0.00',
    });
    expect(out?.kind).toBe('transfer_out');
    expect(out?.primary.quantity).toBe('-0.25');

    const inn = userTransactionToEvent({
      id: 105,
      datetime: '2024-01-15 10:05:00.000000',
      type: '14',
      btc: '0.25',
      fee: '0.00',
    });
    expect(inn?.kind).toBe('transfer_in');
    expect(inn?.primary.quantity).toBe('0.25');
  });

  test('unknown type returns null', () => {
    const ev = userTransactionToEvent({
      id: 106,
      datetime: '2024-01-15 10:06:00.000000',
      type: '99',
      btc: '0.1',
      fee: '0.00',
    });
    expect(ev).toBeNull();
  });
});

describe('BitstampProvider.fetchTransactions', () => {
  test('paginates user_transactions, dedupes, enriches with crypto-tx txid', async () => {
    const p = new BitstampProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    const userTxCalls: number[] = [];
    let cryptoCalls = 0;
    globalThis.fetch = (async (url: string, init?: { body?: BodyInit }) => {
      const body = String(init?.body ?? '');
      if (url.includes('/api/v2/user_transactions/')) {
        const offset = Number(new URLSearchParams(body).get('offset') ?? '0');
        userTxCalls.push(offset);
        if (offset === 0) {
          // Page 1: 2 rows (mixed types). Less than limit=1000 so loop
          // breaks on this page.
          return new Response(
            JSON.stringify([
              {
                id: 1,
                datetime: '2024-01-15 10:00:00.000000',
                type: '0',
                btc: '0.5',
                fee: '0.00',
              },
              {
                id: 2,
                datetime: '2024-01-15 10:30:00.000000',
                type: '2',
                btc: '-0.1',
                usd: '5000.00',
                btc_usd: '50000.00',
                fee: '10.00',
              },
            ]),
            { status: 200 }
          );
        }
        return new Response('[]', { status: 200 });
      }
      if (url.includes('/api/v2/crypto-transactions/')) {
        cryptoCalls += 1;
        if (cryptoCalls === 1) {
          return new Response(
            JSON.stringify({
              deposits: [
                {
                  currency: 'BTC',
                  datetime: '2024-01-15 10:00:00.000000',
                  amount: '0.5',
                  txid: '0xabc123',
                },
              ],
              withdrawals: [],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ deposits: [], withdrawals: [] }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      const out = await p.fetchTransactions(ctx as never);
      expect(out).toHaveLength(2);

      const dep = out.find((e) => e.externalId === 'user-tx:1');
      expect(dep?.kind).toBe('deposit');
      expect((dep?.rawPayload as { txid?: string }).txid).toBe('0xabc123');

      const trade = out.find((e) => e.externalId === 'user-tx:2');
      expect(trade?.kind).toBe('sell');
      expect(trade?.priceNative?.value).toBe('50000');
      // Trade events should not get a txid from the crypto-tx feed.
      expect((trade?.rawPayload as { txid?: string }).txid).toBeUndefined();

      // user_transactions: page 0 returns < 1000, loop breaks after one fetch.
      expect(userTxCalls).toEqual([0]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('continues pagination while a full page comes back', async () => {
    const p = new BitstampProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    const userTxOffsets: number[] = [];
    globalThis.fetch = (async (url: string, init?: { body?: BodyInit }) => {
      const body = String(init?.body ?? '');
      if (url.includes('/api/v2/user_transactions/')) {
        const offset = Number(new URLSearchParams(body).get('offset') ?? '0');
        userTxOffsets.push(offset);
        if (offset === 0) {
          // Return exactly 1000 rows so the loop continues.
          const rows = Array.from({ length: 1000 }, (_, i) => ({
            id: i + 1,
            datetime: '2024-01-15 10:00:00.000000',
            type: '0',
            btc: '0.5',
            fee: '0.00',
          }));
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }
      if (url.includes('/api/v2/crypto-transactions/')) {
        return new Response(JSON.stringify({ deposits: [], withdrawals: [] }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      const out = await p.fetchTransactions(ctx as never);
      expect(out).toHaveLength(1000);
      expect(userTxOffsets).toEqual([0, 1000]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const LIVE = process.env.SCANI_LIVE === '1';
const live = LIVE ? describe : describe.skip;

live('BitstampProvider live (production only — no sandbox)', () => {
  beforeEach(() => {
    // Bitstamp has no public sandbox. SCANI_LIVE=1 hits production
    // with a read-only key the runner has provisioned out-of-band.
  });
  afterEach(() => {});

  test('fetchBalances against production Bitstamp', async () => {
    const apiKey = process.env.SCANI_LIVE_BITSTAMP_API_KEY;
    const apiSecret = process.env.SCANI_LIVE_BITSTAMP_SECRET;
    if (!apiKey || !apiSecret) {
      throw new Error('SCANI_LIVE=1 requires SCANI_LIVE_BITSTAMP_API_KEY / SECRET');
    }
    const p = new BitstampProvider(passthroughLimiter());
    const liveCtx = {
      institutionCode: 'bitstamp',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'live', institutionId: 'live' },
      resolveCredentials: async () => ({ apiKey, apiSecret }),
    };
    const balances = await p.fetchBalances(liveCtx as never);
    expect(Array.isArray(balances)).toBe(true);
  });

  test('fetchTransactions against production Bitstamp', async () => {
    const apiKey = process.env.SCANI_LIVE_BITSTAMP_API_KEY;
    const apiSecret = process.env.SCANI_LIVE_BITSTAMP_SECRET;
    if (!apiKey || !apiSecret) {
      throw new Error('SCANI_LIVE=1 requires SCANI_LIVE_BITSTAMP_API_KEY / SECRET');
    }
    const p = new BitstampProvider(passthroughLimiter());
    const liveCtx = {
      institutionCode: 'bitstamp',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'live', institutionId: 'live' },
      resolveCredentials: async () => ({ apiKey, apiSecret }),
    };
    const events = await p.fetchTransactions(liveCtx as never);
    expect(Array.isArray(events)).toBe(true);
  });
});
