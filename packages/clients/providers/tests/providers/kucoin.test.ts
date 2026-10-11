import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import type { TransactionEvent } from '../../src/core/types';
import { KucoinProvider, ledgerItemToEvent } from '../../src/providers/kucoin';
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
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const r of routes) {
      if (r.match(url)) {
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    }
    return new Response(JSON.stringify({ code: '404', msg: `no route for ${url}` }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
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

  test('ledgerItemToEvent: sub-account transfer, direction out → transfer_out at -amount', () => {
    const event = ledgerItemToEvent({
      id: '1002',
      currency: 'USDT',
      amount: '100',
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
});

describe('KucoinProvider.fetchTransactions — fixture-driven', () => {
  test('walks the ledger and dedups by externalId', async () => {
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
            amount: '0.05',
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

      const byId = new Map(events.map((e) => [e.externalId, e]));
      expect(byId.get('ledger:L2')?.primary.quantity).toBe('-0.05');
      expect(byId.get('ledger:L2')?.fee?.quantity).toBe('-0.0001');
      expect(byId.get('ledger:L1')?.kind).toBe('deposit');
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
      )) as unknown as typeof fetch;
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
      new Response(JSON.stringify({ code: '200000' }), { status: 200 })) as unknown as typeof fetch;
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
      })) as unknown as typeof fetch;
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

/**
 * SC-1478 / SC-1479. KuCoin's account ledger sends `amount` UNSIGNED and carries
 * the side in `direction` (`in` | `out`) — the official spec's own example is
 * `"amount": "0.01"` with `"direction": "out"`. A mapper that signs from `amount`
 * lands every outflow as an inflow and flips the kind with it (a sell becomes
 * `buy`, an outbound transfer `transfer_in`).
 */
describe('KucoinProvider — ledger amounts arrive unsigned; direction carries the side (SC-1478)', () => {
  const row = (bizType: string, direction: 'in' | 'out') => ({
    id: `${bizType}-${direction}`,
    currency: 'USDT',
    amount: '5',
    fee: '0',
    balance: '0',
    accountType: 'MAIN',
    bizType,
    direction,
    createdAt: 1728658481484,
  });

  const outflows = [
    ['Withdrawal', 'withdraw'],
    ['Trade_Exchange', 'sell'],
    ['TRANSFER', 'transfer_out'],
    ['SUB_TRANSFER', 'transfer_out'],
  ] as const;

  for (const [bizType, kind] of outflows) {
    test(`${bizType} out, amount "5" → ${kind} at -5`, () => {
      const event = ledgerItemToEvent(row(bizType, 'out'));
      expect(event?.kind).toBe(kind);
      expect(event?.primary.quantity).toBe('-5');
    });
  }

  test('control: an inflow keeps its kind and positive quantity', () => {
    const event = ledgerItemToEvent(row('Deposit', 'in'));
    expect(event?.kind).toBe('deposit');
    expect(event?.primary.quantity).toBe('5');
  });
});

describe('KucoinProvider — a row with no recognised direction keeps the amount sign (SC-1479)', () => {
  const base = {
    id: 'x',
    currency: 'USDT',
    fee: '0',
    balance: '0',
    accountType: 'MAIN',
    bizType: 'Withdrawal',
    createdAt: 1728658481484,
  };
  test('missing direction, signed -5 stays an outflow at -5', () => {
    const event = ledgerItemToEvent({ ...base, amount: '-5' } as never);
    expect(event?.primary.quantity).toBe('-5');
  });
  test('missing direction, unsigned 5 stays an inflow at +5 (never defaulted to out)', () => {
    const event = ledgerItemToEvent({ ...base, bizType: 'Deposit', amount: '5' } as never);
    expect(event?.kind).toBe('deposit');
    expect(event?.primary.quantity).toBe('5');
  });
});

/**
 * Deposits and withdrawals were also read from `/api/v1/hist-deposits` and
 * `/api/v1/hist-withdrawals`, which KuCoin's API spec marks deprecated and
 * which hold only pre-2019-02-18 records (SC-1575). When one refused, the whole
 * import threw. This stub refuses any path it does not know, as an abandoned
 * endpoint does.
 */
describe('KucoinProvider — no deprecated hist-* endpoint; deposits and withdrawals are ledger rows (SC-1575)', () => {
  const ledger = pagedEnvelope([
    {
      id: 'L-dep',
      currency: 'USDT',
      amount: '6',
      fee: '0',
      balance: '0',
      accountType: 'MAIN',
      bizType: 'Deposit',
      direction: 'in' as const,
      createdAt: 1721730920000,
    },
    {
      id: 'L-wd',
      currency: 'BTC',
      amount: '2.5',
      fee: '0.5',
      balance: '0',
      accountType: 'MAIN',
      bizType: 'Withdrawal',
      direction: 'out' as const,
      createdAt: 1721730930000,
    },
  ]);

  async function fetchLedger(): Promise<{ events: TransactionEvent[]; paths: string[] }> {
    const paths: string[] = [];
    const restore = installFetch([
      {
        match: (u) => {
          paths.push(new URL(u).pathname);
          return false;
        },
        body: null,
      },
      { match: (u) => u.includes('/api/v1/accounts/ledgers'), body: ledger },
    ]);
    try {
      const events = await new KucoinProvider(passthroughLimiter()).fetchTransactions({
        ...ctx,
        since: new Date(1700000000000),
        until: new Date(1730000000000),
      } as never);
      return { events, paths };
    } finally {
      restore();
    }
  }

  test('an import reads the ledger and no hist-* path, so a refused one cannot fail it', async () => {
    const { paths, events } = await fetchLedger();
    // SC-1584 reads the current deposit/withdrawal records for txids; a refusal
    // there is caught, so the ledger rows still arrive.
    expect(paths[0]).toBe('/api/v1/accounts/ledgers');
    expect(paths.some((path) => path.includes('hist-'))).toBe(false);
    expect(
      paths.every((path) =>
        ['/api/v1/accounts/ledgers', '/api/v1/deposits', '/api/v1/withdrawals'].includes(path)
      )
    ).toBe(true);
    expect(events).toHaveLength(2);
  });

  test('the same history writes the same rows: one per ledger deposit and withdrawal', async () => {
    const { events } = await fetchLedger();
    expect(events).toEqual(ledger.data.items.map((item) => ledgerItemToEvent(item)!));
    expect(events.map((e) => e.externalId)).toEqual(['ledger:L-dep', 'ledger:L-wd']);
  });

  /**
   * KuCoin takes a withdrawal fee from the amount or on top of it, chosen by the
   * main account's balance unless the user set `feeDeductType`, and the
   * withdrawal record does not say which. The ledger's `amount` is the balance
   * change with the fee included, so it is the row's whole quantity, and the fee
   * travels only as the fee field: `kucoin-api` is not a gross-of-own-fee
   * source, so no second `fee` row subtracts it again.
   */
  test('a withdrawal moves the balance by the ledger amount, fee included; the fee is only its field', async () => {
    const { events } = await fetchLedger();
    const withdrawal = events.find((e) => e.externalId === 'ledger:L-wd');
    expect(withdrawal?.kind).toBe('withdraw');
    expect(withdrawal?.primary.quantity).toBe('-2.5');
    expect(withdrawal?.fee?.quantity).toBe('-0.5');
  });
});

// SC-1584: a deposit or withdrawal ledger row carries the chain txid from its
// deposit/withdrawal record as `raw_payload.hash`. The join is by currency,
// side, time and amount, so anything short of one-to-one leaves it unset.
describe('KucoinProvider.fetchTransactions — txid on deposits and withdrawals', () => {
  const ledger = (id: string, over: Record<string, unknown>) => ({
    id,
    currency: 'USDT',
    fee: '0',
    balance: '0',
    accountType: 'MAIN',
    ...over,
  });
  const record = (over: Record<string, unknown>) => ({
    currency: 'USDT',
    chain: 'trx',
    status: 'SUCCESS',
    isInner: false,
    fee: '0',
    ...over,
  });
  async function run(routes: Route[], noted: unknown[] = []) {
    const restore = installFetch(routes);
    try {
      const p = new KucoinProvider(passthroughLimiter());
      const events = await p.fetchTransactions({
        ...ctx,
        noteWarning: (n: unknown) => noted.push(n),
      } as never);
      return new Map(events.map((e) => [e.externalId, e.rawPayload as Record<string, unknown>]));
    } finally {
      restore();
    }
  }
  const routes = (ledgerRows: unknown[], deposits: unknown[], withdrawals: unknown[]): Route[] => [
    { match: (u) => u.includes('/api/v1/accounts/ledgers'), body: pagedEnvelope(ledgerRows) },
    { match: (u) => u.includes('/api/v1/deposits'), body: pagedEnvelope(deposits) },
    { match: (u) => u.includes('/api/v1/withdrawals'), body: pagedEnvelope(withdrawals) },
  ];

  test('a deposit gets its record txid with the @suffix stripped, and its chain', async () => {
    const rows = await run(
      routes(
        [
          ledger('D1', {
            amount: '100',
            bizType: 'Deposit',
            direction: 'in',
            createdAt: 1_000_000,
          }),
        ],
        [record({ amount: '100', walletTxId: 'abc123@0', createdAt: 1_005_000 })],
        []
      )
    );
    expect(rows.get('ledger:D1')?.hash).toBe('abc123');
    expect(rows.get('ledger:D1')?.chain).toBe('trx');
  });

  test('a withdrawal matches whether the fee came from the amount or on top of it', async () => {
    const rows = await run(
      routes(
        [
          ledger('W1', {
            amount: '51',
            bizType: 'Withdrawal',
            direction: 'out',
            createdAt: 2_000_000,
          }),
          ledger('W2', {
            amount: '30',
            bizType: 'Withdrawal',
            direction: 'out',
            createdAt: 9_000_000,
          }),
        ],
        [],
        [
          record({
            id: 'r1',
            amount: '50',
            fee: '1',
            walletTxId: 'tx-on-top',
            createdAt: 2_010_000,
          }),
          record({
            id: 'r2',
            amount: '30',
            fee: '1',
            walletTxId: 'tx-inside',
            createdAt: 9_010_000,
          }),
        ]
      )
    );
    expect(rows.get('ledger:W1')?.hash).toBe('tx-on-top');
    expect(rows.get('ledger:W2')?.hash).toBe('tx-inside');
  });

  test('no txid when the join is ambiguous, internal, unfinished or too far apart', async () => {
    const rows = await run(
      routes(
        [
          ledger('A1', { amount: '10', bizType: 'Deposit', direction: 'in', createdAt: 3_000_000 }),
          ledger('I1', {
            amount: '20',
            bizType: 'Withdrawal',
            direction: 'out',
            createdAt: 4_000_000,
          }),
          ledger('P1', { amount: '30', bizType: 'Deposit', direction: 'in', createdAt: 5_000_000 }),
          ledger('F1', { amount: '40', bizType: 'Deposit', direction: 'in', createdAt: 6_000_000 }),
        ],
        [
          record({ amount: '10', walletTxId: 'twin-a', createdAt: 3_001_000 }),
          record({ amount: '10', walletTxId: 'twin-b', createdAt: 3_002_000 }),
          record({
            amount: '30',
            walletTxId: 'pending',
            status: 'PROCESSING',
            createdAt: 5_000_000,
          }),
          record({ amount: '40', walletTxId: 'late', createdAt: 6_000_000 + 61_000 }),
        ],
        [record({ id: 'r3', amount: '20', walletTxId: '', isInner: true, createdAt: 4_000_000 })]
      )
    );
    for (const id of ['A1', 'I1', 'P1', 'F1'])
      expect(rows.get(`ledger:${id}`)?.hash).toBeUndefined();
  });

  test('a record that also fits an ambiguous row is assigned to neither', async () => {
    const rows = await run(
      routes(
        [
          ledger('X1', { amount: '10', bizType: 'Deposit', direction: 'in', createdAt: 8_000_000 }),
          ledger('Y1', { amount: '10', bizType: 'Deposit', direction: 'in', createdAt: 8_050_000 }),
        ],
        [
          record({ amount: '10', walletTxId: 'shared', createdAt: 8_030_000 }),
          record({ amount: '10', walletTxId: 'only-x', createdAt: 7_970_000 }),
        ],
        []
      )
    );
    expect(rows.get('ledger:X1')?.hash).toBeUndefined();
    expect(rows.get('ledger:Y1')?.hash).toBeUndefined();
  });

  // SC-428: the record walks only annotate rows the ledger walk produced, so a
  // capped one costs txids, never the run's history claim.
  test('a capped record walk warns about missing txids and retracts nothing', async () => {
    const full = {
      ...pagedEnvelope(
        Array.from({ length: 500 }, () =>
          record({ currency: 'ZZZ', amount: '1', walletTxId: 'z', createdAt: 0 })
        )
      ),
    };
    full.data.totalPage = 1000;
    const noted: unknown[] = [];
    const retracted: unknown[] = [];
    const restore = installFetch([
      {
        match: (u) => u.includes('/api/v1/accounts/ledgers'),
        body: pagedEnvelope([
          ledger('C1', { amount: '5', bizType: 'Deposit', direction: 'in', createdAt: 9_000_000 }),
        ]),
      },
      { match: (u) => u.includes('/api/v1/deposits'), body: full },
      { match: (u) => u.includes('/api/v1/withdrawals'), body: pagedEnvelope([]) },
    ]);
    try {
      const events = await new KucoinProvider(passthroughLimiter()).fetchTransactions({
        ...ctx,
        noteWarning: (n: unknown) => noted.push(n),
        retractHistoryClaim: (n: unknown) => retracted.push(n),
      } as never);
      expect(events.map((e) => e.externalId)).toEqual(['ledger:C1']);
      expect(retracted).toEqual([]);
      expect(noted.map((n) => (n as { key?: string }).key)).toEqual([
        'v3.jobs.notices.pageCapMissingTxIds',
      ]);
    } finally {
      restore();
    }
  });

  test('a failed record lookup keeps every ledger row and notes a warning', async () => {
    const noted: unknown[] = [];
    const rows = await run(
      [
        {
          match: (u) => u.includes('/api/v1/accounts/ledgers'),
          body: pagedEnvelope([
            ledger('D2', {
              amount: '5',
              bizType: 'Deposit',
              direction: 'in',
              createdAt: 7_000_000,
            }),
          ]),
        },
        {
          match: (u) => u.includes('/api/v1/deposits'),
          body: { code: '400007', msg: 'no permission' },
        },
      ],
      noted
    );
    expect(rows.has('ledger:D2')).toBe(true);
    expect(rows.get('ledger:D2')?.hash).toBeUndefined();
    expect(noted.map((n) => (n as { key?: string }).key)).toEqual([
      'v3.jobs.notices.txIdLookupFailed',
    ]);
  });
});
