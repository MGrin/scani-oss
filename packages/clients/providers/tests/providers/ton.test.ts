import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { TonProvider } from '../../src/providers/ton';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const VALID_TON_FRIENDLY = 'EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y';
const VALID_TON_RAW = '0:fc1ee4a0d35d40a82a64efe0bdfe28db4ecbabbafe7df7d39f7e51a7c66dba61';
const VALID_TON_TESTNET = 'kQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2EmnNl';

const ctx = {
  institutionCode: 'ton',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ walletAddress: VALID_TON_FRIENDLY }),
};

describe('TonProvider', () => {
  test('canFetchBalances / canFetchTransactions / canValidate gate on ton', () => {
    const p = new TonProvider(passthroughLimiter(), 'http://api');
    expect(p.canFetchBalances('ton')).toBe(true);
    expect(p.canFetchTransactions('ton')).toBe(true);
    expect(p.canValidate('ton')).toBe(true);
    expect(p.canFetchBalances('ethereum')).toBe(false);
    expect(p.canFetchTransactions('ethereum')).toBe(false);
  });

  test('isValidAddress accepts mainnet, testnet, and raw forms', () => {
    const p = new TonProvider(passthroughLimiter(), 'http://api');
    expect(p.isValidAddress(VALID_TON_FRIENDLY)).toBe(true);
    expect(p.isValidAddress(VALID_TON_RAW)).toBe(true);
    expect(p.isValidAddress(VALID_TON_TESTNET)).toBe(true);
    expect(p.isValidAddress('not-an-address')).toBe(false);
  });

  test('fetchBalances converts nanoTons to TON', async () => {
    const p = new TonProvider(passthroughLimiter(), 'http://api');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, result: '2500000000' }), // 2.5 TON
        { status: 200 }
      )) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toHaveLength(1);
      expect(out[0]?.tokenIdentity.symbol).toBe('TON');
      expect(out[0]?.balance).toBe('2.5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchBalances returns empty when balance is zero', async () => {
    const p = new TonProvider(passthroughLimiter(), 'http://api');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: '0' }), { status: 200 })) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(out).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchBalances forwards X-API-Key header when key configured', async () => {
    const p = new TonProvider(passthroughLimiter(), 'http://api', 'sekret');
    const originalFetch = globalThis.fetch;
    let seenKey: string | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenKey = headers.get('x-api-key');
      return new Response(JSON.stringify({ ok: true, result: '0' }), { status: 200 });
    }) as typeof fetch;
    try {
      await p.fetchBalances(ctx as never);
      expect(seenKey).toBe('sekret');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: emits transfer_in + transfer_out, position-based legIndex', async () => {
    const p = new TonProvider(passthroughLimiter(), 'http://api');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      expect(url).toContain('limit=100');
      expect(url).toContain('to_lt=0');
      // Single short page → loop terminates after one call.
      const body = {
        ok: true,
        result: [
          {
            utime: 1_700_000_000,
            transaction_id: { lt: '111', hash: 'hashA' },
            in_msg: {
              source: 'EQSomeSender',
              destination: VALID_TON_FRIENDLY,
              value: '1500000000', // 1.5 TON in
            },
            out_msgs: [
              {
                source: VALID_TON_FRIENDLY,
                destination: 'EQRecipient',
                value: '500000000', // 0.5 TON out
              },
            ],
          },
        ],
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events).toHaveLength(2);

      const inflow = events.find((e) => e.kind === 'transfer_in');
      expect(inflow?.externalId).toBe('111-hashA-0');
      expect(inflow?.primary.quantity).toBe('1.5');
      expect(inflow?.primary.tokenIdentity.symbol).toBe('TON');
      expect(inflow?.primary.tokenIdentity.decimals).toBe(9);
      expect(inflow?.occurredAt.getTime()).toBe(1_700_000_000 * 1000);

      const outflow = events.find((e) => e.kind === 'transfer_out');
      expect(outflow?.externalId).toBe('111-hashA-1');
      expect(outflow?.primary.quantity).toBe('-0.5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: skips smart-contract rows where all messages are 0-value', async () => {
    const p = new TonProvider(passthroughLimiter(), 'http://api');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const body = {
        ok: true,
        result: [
          {
            utime: 1_700_000_100,
            transaction_id: { lt: '222', hash: 'hashB' },
            in_msg: {
              source: 'EQSomeSender',
              destination: VALID_TON_FRIENDLY,
              value: '0',
            },
            out_msgs: [
              {
                source: VALID_TON_FRIENDLY,
                destination: 'EQOther',
                value: '0',
              },
            ],
          },
        ],
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: paginates via lt/hash cursor until short page', async () => {
    const p = new TonProvider(passthroughLimiter(), 'http://api');
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    // Page 1: 100 rows (full) → cursor advances.
    // Page 2: 1 row (short)   → loop terminates.
    const fullPage = Array.from({ length: 100 }, (_, idx) => ({
      utime: 1_700_000_000 + idx,
      transaction_id: { lt: String(1000 - idx), hash: `h${idx}` },
      in_msg: {
        source: 'EQS',
        destination: VALID_TON_FRIENDLY,
        value: '1000000000',
      },
      out_msgs: [],
    }));
    const lastFullRow = fullPage[fullPage.length - 1];
    if (!lastFullRow) throw new Error('test setup: full page missing last row');
    const expectedCursorLt = lastFullRow.transaction_id.lt;
    const expectedCursorHash = lastFullRow.transaction_id.hash;
    const tailPage = [
      {
        utime: 1_699_999_000,
        transaction_id: { lt: '900', hash: 'tail' },
        in_msg: {
          source: 'EQS',
          destination: VALID_TON_FRIENDLY,
          value: '2000000000',
        },
        out_msgs: [],
      },
    ];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      const isFirst = !url.includes('hash=');
      const body = isFirst ? { ok: true, result: fullPage } : { ok: true, result: tailPage };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(calls).toHaveLength(2);
      expect(calls[0]).not.toContain('hash=');
      expect(calls[1]).toContain(`lt=${expectedCursorLt}`);
      expect(calls[1]).toContain(`hash=${expectedCursorHash}`);
      // 100 inflows + 1 inflow tail.
      expect(events).toHaveLength(101);
      expect(events[events.length - 1]?.externalId).toBe('900-tail-0');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: applies since/until filters in-memory', async () => {
    const p = new TonProvider(passthroughLimiter(), 'http://api');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              utime: 1_600_000_000,
              transaction_id: { lt: '1', hash: 'old' },
              in_msg: {
                source: 'EQS',
                destination: VALID_TON_FRIENDLY,
                value: '1000000000',
              },
              out_msgs: [],
            },
            {
              utime: 1_800_000_000,
              transaction_id: { lt: '2', hash: 'new' },
              in_msg: {
                source: 'EQS',
                destination: VALID_TON_FRIENDLY,
                value: '2000000000',
              },
              out_msgs: [],
            },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;
    try {
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date(1_700_000_000 * 1000),
      } as never);
      expect(events.map((e) => e.externalId)).toEqual(['2-new-0']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchTransactions: returns [] for invalid wallet address', async () => {
    const p = new TonProvider(passthroughLimiter(), 'http://api');
    const events = await p.fetchTransactions({
      ...ctx,
      resolveCredentials: async () => ({ walletAddress: 'not-a-ton-address' }),
    } as never);
    expect(events).toEqual([]);
  });
});

// Live test against the public Toncenter API. Hits a known public TON
// foundation address so the shape assertion is stable. Opt-in via
// SCANI_LIVE=1.
test.skipIf(process.env.SCANI_LIVE !== '1')(
  'TonProvider — live toncenter.com /getTransactions returns events',
  async () => {
    const provider = new TonProvider(
      passthroughLimiter(),
      process.env.TON_API_URL ?? 'https://toncenter.com/api/v2',
      process.env.TON_API_KEY
    );
    const events = await provider.fetchTransactions({
      institutionCode: 'ton',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'live', institutionId: 'live' },
      resolveCredentials: async () => ({
        walletAddress: 'EQCD39VS5jcptHL8vMjEXrzGaRcCryK5tRIgU4l1pvCmHv9b',
      }),
    });
    expect(Array.isArray(events)).toBe(true);
    for (const e of events) {
      expect(e.primary.tokenIdentity.symbol).toBe('TON');
      expect(['transfer_in', 'transfer_out']).toContain(e.kind);
    }
  },
  60_000
);
