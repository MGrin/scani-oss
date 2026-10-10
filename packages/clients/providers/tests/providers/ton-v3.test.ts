import { afterEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { TonProvider } from '../../src/providers/ton';

/**
 * toncenter API v3 (SC-1580). The two transaction fixtures are trimmed from
 * real `GET /api/v3/transactions` responses recorded 2026-10-05. API v2's
 * `getTransactions` for the same two transactions returned the same `lt`,
 * `hash`, time and values, so the rows below are the rows v2 produced: the
 * move changes no externalId and no quantity. v3 names every address in raw
 * form (`0:<HEX>`) and its address book in the non-bounceable form, while a
 * user saves the bounceable one, so an address is matched by account, never
 * by string. The outbound amount and the balance are replaced with round
 * invented values; the shape, addresses, lt and hash are as recorded.
 */

const FOUNDATION_BOUNCEABLE = 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N';
const FOUNDATION_RAW = '0:83DFD552E63729B472FCBCC8C45EBCC6691702558B68EC7527E1BA403A0F31A8';
const SENDER_BOUNCEABLE = 'EQBTv_M24QMqbiyEhnjNCfYU50L2RfmH9JCUiTw1xpknCVdU';
const SENDER_RAW = '0:53BFF336E1032A6E2C848678CD09F614E742F645F987F49094893C35C6992709';

const INBOUND = {
  transactions: [
    {
      account: FOUNDATION_RAW,
      hash: 'zTjeH/kNj436g9YjHD0LMvlw8F+f/JRVLHcbP3NBZMc=',
      lt: '107893488000006',
      now: 1791174827,
      in_msg: {
        source: '0:FA909B54E2961F6492BC5E108DD9E83A5BDC5C4B63FA1DA354E7A814403AE016',
        destination: FOUNDATION_RAW,
        value: '1000000',
      },
      out_msgs: [],
    },
  ],
  address_book: {
    [FOUNDATION_RAW]: { user_friendly: 'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI' },
  },
};

const OUTBOUND = {
  transactions: [
    {
      account: SENDER_RAW,
      hash: 'cYXQTGmlZD8fsKV10xWAcv3Qvonw8OPYD/xKn+xi0Ng=',
      lt: '107828062000023',
      now: 1791148656,
      in_msg: { source: null, destination: SENDER_RAW, value: null },
      out_msgs: [
        {
          source: SENDER_RAW,
          destination: '0:28E94DC6F5B11C0DC706244FD59B12E30DC019DFEE22812D9B95D2916FD16337',
          value: '1500000000',
        },
      ],
    },
  ],
  address_book: {
    [SENDER_RAW]: { user_friendly: SENDER_BOUNCEABLE },
  },
};

function accountState(status: string, balance: string) {
  return { accounts: [{ address: SENDER_RAW, balance, status }], address_book: {} };
}

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

function ctxFor(walletAddress: string) {
  return {
    institutionCode: 'ton',
    baseCurrency: { id: 'usd', symbol: 'USD' } as never,
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => ({ walletAddress }),
  };
}

const originalFetch = globalThis.fetch;
let calls: URL[] = [];

function serveV3(routes: Record<string, (url: URL) => unknown>) {
  calls = [];
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    const route = Object.entries(routes).find(([path]) => url.pathname === `/api/v3${path}`);
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route[1](url)), { status: 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const provider = () => new TonProvider(passthroughLimiter(), 'https://toncenter.test/api/v3');

describe('TonProvider on toncenter API v3 (SC-1580)', () => {
  test('an inbound transfer is the row v2 wrote, matched by account although v3 names it raw', async () => {
    serveV3({ '/transactions': () => INBOUND });
    const events = await provider().fetchTransactions(ctxFor(FOUNDATION_BOUNCEABLE) as never);
    expect(events).toEqual([
      {
        externalId: '107893488000006-zTjeH/kNj436g9YjHD0LMvlw8F+f/JRVLHcbP3NBZMc=-0',
        occurredAt: new Date(1791174827 * 1000),
        kind: 'transfer_in',
        primary: {
          tokenIdentity: expect.objectContaining({ symbol: 'TON', decimals: 9 }),
          quantity: '0.001',
        },
      },
    ]);
  });

  test('an outbound transfer is the row v2 wrote; the external in-message carries no value', async () => {
    serveV3({ '/transactions': () => OUTBOUND });
    const events = await provider().fetchTransactions(ctxFor(SENDER_BOUNCEABLE) as never);
    expect(events.map((e) => [e.externalId, e.kind, e.primary.quantity])).toEqual([
      ['107828062000023-cYXQTGmlZD8fsKV10xWAcv3Qvonw8OPYD/xKn+xi0Ng=-1', 'transfer_out', '-1.5'],
    ]);
  });

  test('a wallet saved in raw form matches as well', async () => {
    serveV3({ '/transactions': () => INBOUND });
    const events = await provider().fetchTransactions(
      ctxFor(FOUNDATION_RAW.toLowerCase()) as never
    );
    expect(events.map((e) => e.kind)).toEqual(['transfer_in']);
  });

  test('pages backwards by lt, newest first, until a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      ...INBOUND.transactions[0],
      hash: `h${i}`,
      lt: String(5000 - i),
    }));
    serveV3({
      '/transactions': (url) =>
        url.searchParams.has('end_lt') ? INBOUND : { transactions: full, address_book: {} },
    });
    const events = await provider().fetchTransactions(ctxFor(FOUNDATION_BOUNCEABLE) as never);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.searchParams.get('account')).toBe(FOUNDATION_BOUNCEABLE);
    expect(calls[0]?.searchParams.get('sort')).toBe('desc');
    expect(calls[0]?.searchParams.get('limit')).toBe('100');
    expect(calls[1]?.searchParams.get('end_lt')).toBe('4900');
    expect(events).toHaveLength(101);
  });

  test('balance comes from accountStates, in TON', async () => {
    serveV3({ '/accountStates': () => accountState('active', '2500000') });
    const out = await provider().fetchBalances(ctxFor(SENDER_BOUNCEABLE) as never);
    expect(out.map((h) => [h.externalId, h.balance])).toEqual([['native', '0.0025']]);
    expect(calls[0]?.searchParams.get('address')).toBe(SENDER_BOUNCEABLE);
  });

  test('an address v3 has never seen is no account: no activity and no balance', async () => {
    serveV3({ '/accountStates': () => ({ accounts: [], address_book: {}, metadata: {} }) });
    expect(await provider().hasActivity(SENDER_BOUNCEABLE, 'ton', {} as never)).toBe(false);
    expect(await provider().fetchBalances(ctxFor(SENDER_BOUNCEABLE) as never)).toEqual([]);
  });

  test('an account that was never used has no activity; an active one has', async () => {
    for (const [status, expected] of [
      ['nonexist', false],
      ['uninit', false],
      ['active', true],
    ] as const) {
      serveV3({ '/accountStates': () => accountState(status, '0') });
      expect(await provider().hasActivity(SENDER_BOUNCEABLE, 'ton', {} as never)).toBe(expected);
    }
  });
});
