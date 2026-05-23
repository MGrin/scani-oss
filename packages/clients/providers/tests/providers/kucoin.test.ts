import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import {
  histDepositToEvent,
  histWithdrawalToEvent,
  KucoinProvider,
  ledgerItemToEvent,
} from '../../src/providers/kucoin';
import { mapKucoinBizType } from '../../src/providers/kucoin/biz-types';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'kucoin',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's', passphrase: 'p' }),
};

type Route = { match: (url: string) => boolean; body: unknown; status?: number };

function installFetch(routes: Route[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const r of routes) {
      if (r.match(url)) {
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    }
    return new Response(JSON.stringify({ code: '404', msg: `no route for ${url}` }), {
      status: 200,
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function pagedEnvelope<T>(items: T[]): {
  code: string;
  data: {
    currentPage: number;
    pageSize: number;
    totalNum: number;
    totalPage: number;
    items: T[];
  };
} {
  return {
    code: '200000',
    data: {
      currentPage: 1,
      pageSize: 500,
      totalNum: items.length,
      totalPage: 1,
      items,
    },
  };
}

describe('KucoinProvider — biz-type mapping', () => {
  test('Deposit/Withdrawal map to fixed kinds', () => {
    expect(mapKucoinBizType('Deposit', true)).toBe('deposit');
    expect(mapKucoinBizType('Withdrawal', false)).toBe('withdraw');
  });

  test('Exchange / Trade_Exchange map by sign to buy/sell', () => {
    expect(mapKucoinBizType('Exchange', true)).toBe('buy');
    expect(mapKucoinBizType('Exchange', false)).toBe('sell');
    expect(mapKucoinBizType('Trade_Exchange', true)).toBe('buy');
    expect(mapKucoinBizType('Trade_Exchange', false)).toBe('sell');
  });

  test('Sub-account transfer + MAIN_TRANSFER map by sign to transfer_in/out', () => {
    expect(mapKucoinBizType('Sub-account transfer', true)).toBe('transfer_in');
    expect(mapKucoinBizType('Sub-account transfer', false)).toBe('transfer_out');
    expect(mapKucoinBizType('MAIN_TRANSFER', true)).toBe('transfer_in');
    expect(mapKucoinBizType('MAIN_TRANSFER', false)).toBe('transfer_out');
  });

  test('Convert to KCS maps by sign to swap_in/out', () => {
    expect(mapKucoinBizType('Convert to KCS', true)).toBe('swap_in');
    expect(mapKucoinBizType('Convert to KCS', false)).toBe('swap_out');
  });

  test('Rewards / staking map to reward / interest', () => {
    expect(mapKucoinBizType('Rebate', true)).toBe('reward');
    expect(mapKucoinBizType('Distribution', true)).toBe('reward');
    expect(mapKucoinBizType('KuCoin Bonus', true)).toBe('reward');
    expect(mapKucoinBizType('Staking', true)).toBe('interest');
  });

  test('Unknown bizType falls through to unknown', () => {
    expect(mapKucoinBizType('SomeFutureBizType', true)).toBe('unknown');
  });
});

describe('KucoinProvider — pure mappers', () => {
  test('ledgerItemToEvent: trade row → buy with signed quantity, fee negated', () => {
    const event = ledgerItemToEvent({
      id: '1001',
      currency: 'BTC',
      amount: '0.5',
      fee: '0.0001',
      balance: '0.6',
      bizType: 'Trade_Exchange',
      direction: 'in',
      createdAt: 1700000000000,
    });
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('buy');
    expect(event?.primary.quantity).toBe('0.5');
    expect(event?.fee?.quantity).toBe('-0.0001');
    expect(event?.externalId).toBe('ledger:1001');
    expect(event?.occurredAt.getTime()).toBe(1700000000000);
  });

  test('ledgerItemToEvent: sub-account transfer with negative amount → transfer_out', () => {
    const event = ledgerItemToEvent({
      id: '1002',
      currency: 'USDT',
      amount: '-100',
      fee: '0',
      balance: '900',
      bizType: 'Sub-account transfer',
      direction: 'out',
      createdAt: 1700000001000,
    });
    expect(event?.kind).toBe('transfer_out');
    expect(event?.primary.quantity).toBe('-100');
    expect(event?.fee).toBeUndefined();
  });

  test('ledgerItemToEvent: zero-amount row is skipped', () => {
    expect(
      ledgerItemToEvent({
        id: '1003',
        currency: 'BTC',
        amount: '0',
        fee: '0',
        balance: '0',
        bizType: 'Deposit',
        direction: 'in',
        createdAt: 1700000002000,
      })
    ).toBeNull();
  });

  test('histDepositToEvent: positive deposit, prefixed externalId', () => {
    const event = histDepositToEvent({
      currency: 'eth',
      createAt: 1700000000,
      amount: '2.5',
      walletTxId: '0xdeadbeef',
    });
    expect(event.kind).toBe('deposit');
    expect(event.primary.quantity).toBe('2.5');
    expect(event.primary.tokenIdentity.symbol).toBe('ETH');
    expect(event.externalId).toBe('hist-deposit:0xdeadbeef');
    expect(event.occurredAt.getTime()).toBe(1700000000 * 1000);
  });

  test('histWithdrawalToEvent: amount comes back negative', () => {
    const event = histWithdrawalToEvent({
      id: 'w-9',
      currency: 'btc',
      createAt: 1700000050,
      amount: '0.1',
      walletTxId: '0xabc',
    });
    expect(event.kind).toBe('withdraw');
    expect(event.primary.quantity).toBe('-0.1');
    expect(event.externalId).toBe('hist-withdrawal:w-9');
  });
});

describe('KucoinProvider.fetchTransactions — fixture-driven', () => {
  test('walks ledger + hist-deposits + hist-withdrawals and dedups by externalId', async () => {
    const restore = installFetch([
      {
        match: (u) => u.includes('/api/v1/accounts/ledgers'),
        body: pagedEnvelope([
          {
            id: 'L1',
            currency: 'BTC',
            amount: '0.2',
            fee: '0',
            balance: '0.2',
            bizType: 'Deposit',
            direction: 'in',
            createdAt: 1700000000000,
          },
          {
            id: 'L2',
            currency: 'BTC',
            amount: '-0.05',
            fee: '0.0001',
            balance: '0.15',
            bizType: 'Trade_Exchange',
            direction: 'out',
            createdAt: 1700000010000,
          },
          {
            id: 'L3',
            currency: 'KCS',
            amount: '5',
            fee: '0',
            balance: '5',
            bizType: 'Convert to KCS',
            direction: 'in',
            createdAt: 1700000020000,
          },
        ]),
      },
      {
        match: (u) => u.includes('/api/v1/hist-deposits'),
        body: pagedEnvelope([
          {
            currency: 'ETH',
            createAt: 1690000000,
            amount: '1.5',
            walletTxId: '0xeeed',
          },
        ]),
      },
      {
        match: (u) => u.includes('/api/v1/hist-withdrawals'),
        body: pagedEnvelope([
          {
            id: 'w-1',
            currency: 'BTC',
            createAt: 1690000050,
            amount: '0.01',
            walletTxId: '0xwww',
          },
        ]),
      },
    ]);

    try {
      const p = new KucoinProvider(passthroughLimiter());
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date(1689000000000),
        until: new Date(1700100000000),
      } as never);

      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain('deposit');
      expect(kinds).toContain('sell');
      expect(kinds).toContain('swap_in');
      expect(kinds).toContain('withdraw');

      const byId = new Map(events.map((e) => [e.externalId, e]));
      expect(byId.get('ledger:L2')?.primary.quantity).toBe('-0.05');
      expect(byId.get('ledger:L2')?.fee?.quantity).toBe('-0.0001');
      expect(byId.get('hist-deposit:0xeeed')?.kind).toBe('deposit');
      expect(byId.get('hist-withdrawal:w-1')?.primary.quantity).toBe('-0.01');
    } finally {
      restore();
    }
  });

  test('empty creds (no passphrase) → empty array', async () => {
    const p = new KucoinProvider(passthroughLimiter());
    const events = await p.fetchTransactions({
      ...ctx,
      resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
    } as never);
    expect(events).toEqual([]);
  });

  test('non-200000 ledger response throws ProviderError', async () => {
    const restore = installFetch([
      {
        match: (u) => u.includes('/api/v1/accounts/ledgers'),
        body: { code: '400100', msg: 'bad signature' },
      },
    ]);
    try {
      const p = new KucoinProvider(passthroughLimiter());
      await expect(p.fetchTransactions(ctx as never)).rejects.toThrow(/400100/);
    } finally {
      restore();
    }
  });
});

describe('KucoinProvider', () => {
  test('canFetchBalances gates on kucoin', () => {
    const p = new KucoinProvider(passthroughLimiter());
    expect(p.canFetchBalances('kucoin')).toBe(true);
    expect(p.canFetchBalances('binance')).toBe(false);
  });

  test('canFetchTransactions gates on kucoin', () => {
    const p = new KucoinProvider(passthroughLimiter());
    expect(p.canFetchTransactions('kucoin')).toBe(true);
    expect(p.canFetchTransactions('binance')).toBe(false);
  });

  test('fetchBalances sums across account types per currency, drops zeros, uppercases symbol', async () => {
    const p = new KucoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: '200000',
          data: [
            { currency: 'btc', type: 'trade', balance: '0.4', available: '0.4' },
            { currency: 'btc', type: 'main', balance: '0.1', available: '0.1' },
            { currency: 'usdt', type: 'trade', balance: '0', available: '0' },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toHaveLength(1);
      expect(out[0]?.tokenIdentity.symbol).toBe('BTC');
      expect(out[0]?.balance).toBe('0.5');
      const meta = out[0]?.tokenIdentity.providerMetadata as { kucoin: { currency: string } };
      expect(meta.kucoin.currency).toBe('btc');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects missing passphrase', async () => {
    const p = new KucoinProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'kucoin');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('passphrase');
  });

  test('validateCredentials returns true on success', async () => {
    const p = new KucoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: '200000' }), { status: 200 })) as typeof fetch;
    try {
      const r = await p.validateCredentials(
        { apiKey: 'k', apiSecret: 's', passphrase: 'p' },
        'kucoin'
      );
      expect(r.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials returns false on non-200000 code', async () => {
    const p = new KucoinProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: '400003', msg: 'bad' }), {
        status: 200,
      })) as typeof fetch;
    try {
      const r = await p.validateCredentials(
        { apiKey: 'k', apiSecret: 's', passphrase: 'p' },
        'kucoin'
      );
      expect(r.valid).toBe(false);
      expect(r.message).toContain('400003');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// SCANI_LIVE=1 hits production /api/v1/accounts/ledgers + hist-* endpoints.
// User must create a throwaway KuCoin account with read-only API keys and
// a small balance, then export KUCOIN_API_KEY / KUCOIN_API_SECRET /
// KUCOIN_API_PASSPHRASE before running. Skipped by default.
const liveMode = process.env.SCANI_LIVE === '1';
const liveDescribe = liveMode ? describe : describe.skip;

liveDescribe('KucoinProvider — live (SCANI_LIVE=1, throwaway account)', () => {
  test('fetchTransactions hits production with read-only creds', async () => {
    const apiKey = process.env.KUCOIN_API_KEY;
    const apiSecret = process.env.KUCOIN_API_SECRET;
    const passphrase = process.env.KUCOIN_API_PASSPHRASE;
    if (!apiKey || !apiSecret || !passphrase) {
      throw new Error('SCANI_LIVE=1 requires KUCOIN_API_KEY/SECRET/PASSPHRASE');
    }

    const p = new KucoinProvider(passthroughLimiter());
    const liveCtx = {
      institutionCode: 'kucoin',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'u', institutionId: 'i' },
      resolveCredentials: async () => ({ apiKey, apiSecret, passphrase }),
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    };
    const events = await p.fetchTransactions(liveCtx as never);
    expect(Array.isArray(events)).toBe(true);
  });
});
