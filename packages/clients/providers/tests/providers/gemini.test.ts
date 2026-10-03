import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { GeminiProvider } from '../../src/providers/gemini';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'gemini',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
};

describe('GeminiProvider', () => {
  test('canFetchBalances gates on gemini', () => {
    const p = new GeminiProvider(passthroughLimiter());
    expect(p.canFetchBalances('gemini')).toBe(true);
    expect(p.canFetchBalances('coinbase')).toBe(false);
  });

  test('canFetchTransactions gates on gemini', () => {
    const p = new GeminiProvider(passthroughLimiter());
    expect(p.canFetchTransactions('gemini')).toBe(true);
    expect(p.canFetchTransactions('coinbase')).toBe(false);
  });

  test('capabilities advertise transactions', () => {
    const p = new GeminiProvider(passthroughLimiter());
    expect(p.capabilities).toContain('transactions');
  });

  test('fetchBalances filters zero amounts and uppercases symbol', async () => {
    const p = new GeminiProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { currency: 'BTC', amount: '0.25', type: 'exchange' },
          { currency: 'usd', amount: '0', type: 'exchange' },
          { currency: 'eth', amount: '1.5', type: 'exchange' },
        ]),
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      const symbols = out.map((h) => h.tokenIdentity.symbol).sort();
      expect(symbols).toEqual(['BTC', 'ETH']);
      expect(out.find((h) => h.tokenIdentity.symbol === 'BTC')?.balance).toBe('0.25');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new GeminiProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'binance');
    expect(r.valid).toBe(false);
  });

  test('validateCredentials returns true on 200', async () => {
    const p = new GeminiProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'gemini');
      expect(r.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials maps 401 to invalid', async () => {
    const p = new GeminiProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'gemini');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('gemini HTTP 401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('GeminiProvider.signRequest payload merge', () => {
  test('merges payloadExtras into the base64 JSON payload', async () => {
    const p = new GeminiProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    let capturedPayload: Record<string, unknown> | null = null;

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const b64 = headers?.['X-GEMINI-PAYLOAD'];
      if (b64) {
        capturedPayload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await p.fetchTransactions({ ...ctx } as never);
      // The very first call is /v1/balances with no extras; it must
      // still produce a valid payload containing request + nonce.
      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload!.request).toBeDefined();
      expect(capturedPayload!.nonce).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('mytrades payload includes symbol, limit_trades, and timestamp on cursor advance', async () => {
    const p = new GeminiProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    const capturedPayloads: Record<string, unknown>[] = [];

    // 500 trades → first page hits the page-size threshold so the loop
    // walks the cursor back for a second request.
    const fullPage = Array.from({ length: 500 }, (_, i) => ({
      tid: 1000 + i,
      symbol: 'btcusd',
      price: '30000',
      amount: '0.001',
      timestamp: 1_700_000_000 + i,
      timestampms: 1_700_000_000_000 + i * 1000,
      type: 'Buy' as const,
    }));
    const oldestMs = 1_700_000_000_000;

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      const b64 = headers?.['X-GEMINI-PAYLOAD'];
      const payload = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : {};

      if (u.endsWith('/v1/balances')) {
        return new Response(
          JSON.stringify([{ currency: 'BTC', amount: '0.5', type: 'exchange' }]),
          { status: 200 }
        );
      }
      if (u.endsWith('/v1/mytrades')) {
        capturedPayloads.push(payload);
        if ((payload as { timestamp?: number }).timestamp === undefined) {
          return new Response(JSON.stringify(fullPage), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }
      if (u.endsWith('/v2/transfers')) {
        return new Response('[]', { status: 200 });
      }
      throw new Error(`unexpected url: ${u}`);
    }) as unknown as typeof fetch;

    try {
      await p.fetchTransactions({ ...ctx } as never);
      const firstMytrades = capturedPayloads[0];
      expect(firstMytrades).toBeDefined();
      expect(firstMytrades!.request).toBe('/v1/mytrades');
      expect(firstMytrades!.symbol).toBe('btcusd');
      expect(firstMytrades!.limit_trades).toBe(500);
      // First page omits timestamp (most recent).
      expect((firstMytrades as { timestamp?: number }).timestamp).toBeUndefined();

      // Second page advances cursor to oldest.timestampms - 1.
      const secondMytrades = capturedPayloads[1];
      expect(secondMytrades).toBeDefined();
      expect(secondMytrades!.timestamp).toBe(oldestMs - 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('GeminiProvider.fetchTransactions', () => {
  test('maps mytrades fixture to buy/sell events with counter + fee legs', async () => {
    const p = new GeminiProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith('/v1/balances')) {
        return new Response(
          JSON.stringify([{ currency: 'BTC', amount: '0.5', type: 'exchange' }]),
          { status: 200 }
        );
      }
      if (u.endsWith('/v1/mytrades')) {
        // Single page with one Buy + one Sell. Page returns < 500 → loop terminates.
        return new Response(
          JSON.stringify([
            {
              tid: 100,
              symbol: 'btcusd',
              price: '30000',
              amount: '0.1',
              timestamp: 1_700_000_000,
              timestampms: 1_700_000_000_000,
              type: 'Buy',
              fee_currency: 'USD',
              fee_amount: '3',
            },
            {
              tid: 101,
              symbol: 'btcusd',
              price: '31000',
              amount: '0.05',
              timestamp: 1_700_000_500,
              timestampms: 1_700_000_500_000,
              type: 'Sell',
              fee_currency: 'USD',
              fee_amount: '1.55',
            },
          ]),
          { status: 200 }
        );
      }
      if (u.endsWith('/v2/transfers')) {
        return new Response('[]', { status: 200 });
      }
      throw new Error(`unexpected url: ${u}`);
    }) as unknown as typeof fetch;

    try {
      const events = await p.fetchTransactions({ ...ctx } as never);
      // 1 buy + 1 sell (each held-asset × 3 quotes = 3 symbols, but
      // only btcusd has trades; btcusdt + btcbtc-skipped-self = empty).
      const buy = events.find((e) => e.kind === 'buy');
      const sell = events.find((e) => e.kind === 'sell');
      expect(buy).toBeDefined();
      expect(sell).toBeDefined();

      // Buy: primary BTC positive, counter USD negative.
      expect(buy!.externalId).toBe('trade-btcusd-100');
      expect(buy!.primary.tokenIdentity.symbol).toBe('BTC');
      expect(buy!.primary.quantity).toBe('0.1');
      expect(buy!.counter?.tokenIdentity.symbol).toBe('USD');
      expect(buy!.counter?.quantity).toBe('-3000');
      expect(buy!.priceNative?.value).toBe('30000');
      expect(buy!.fee?.tokenIdentity.symbol).toBe('USD');
      expect(buy!.fee?.quantity).toBe('-3');

      // Sell: primary BTC negative, counter USD positive.
      expect(sell!.primary.quantity).toBe('-0.05');
      expect(sell!.counter?.quantity).toBe('1550');
      expect(sell!.fee?.quantity).toBe('-1.55');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('paginates /v2/transfers via continuation_token header', async () => {
    const p = new GeminiProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;

    let transferCalls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      const b64 = headers?.['X-GEMINI-PAYLOAD'];
      const payload = b64
        ? (JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>)
        : {};

      if (u.endsWith('/v1/balances')) {
        return new Response('[]', { status: 200 });
      }
      if (u.endsWith('/v2/transfers')) {
        transferCalls += 1;
        if (transferCalls === 1) {
          expect(payload.continuation_token).toBeUndefined();
          return new Response(
            JSON.stringify([
              {
                eid: 1,
                type: 'Deposit',
                status: 'Complete',
                timestampms: 1_690_000_000_000,
                currency: 'BTC',
                amount: '0.25',
                txHash: 'abcd',
              },
            ]),
            { status: 200, headers: { continuation_token: 'tok-2' } }
          );
        }
        if (transferCalls === 2) {
          expect(payload.continuation_token).toBe('tok-2');
          return new Response(
            JSON.stringify([
              {
                eid: 2,
                type: 'Withdrawal',
                status: 'Complete',
                timestampms: 1_695_000_000_000,
                currency: 'USD',
                amount: '500',
              },
            ]),
            { status: 200 }
          );
        }
        return new Response('[]', { status: 200 });
      }
      throw new Error(`unexpected url: ${u}`);
    }) as unknown as typeof fetch;

    try {
      const events = await p.fetchTransactions({ ...ctx } as never);
      expect(transferCalls).toBe(2);

      const dep = events.find((e) => e.kind === 'deposit');
      const wd = events.find((e) => e.kind === 'withdraw');
      expect(dep).toBeDefined();
      expect(wd).toBeDefined();
      expect(dep!.externalId).toBe('transfer-1');
      expect(dep!.primary.tokenIdentity.symbol).toBe('BTC');
      expect(dep!.primary.quantity).toBe('0.25');
      expect(wd!.externalId).toBe('transfer-2');
      expect(wd!.primary.tokenIdentity.symbol).toBe('USD');
      expect(wd!.primary.quantity).toBe('-500');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Live integration test against the Gemini sandbox.
  //
  // Sandbox setup:
  //   1. Sign up at https://exchange.sandbox.gemini.com/.
  //   2. Settings → API → create key with Auditor (read-only) scope.
  //   3. Place sandbox test trades in the web UI to populate history.
  //   4. Export:
  //        SCANI_TESTNET_GEMINI_API_KEY=...
  //        SCANI_TESTNET_GEMINI_API_SECRET=...
  //        SCANI_TESTNET_GEMINI_BASE_URL=https://api.sandbox.gemini.com
  //   5. Run: SCANI_LIVE=1 bun test packages/clients/providers/tests/providers/gemini.test.ts
  //
  // Disabled in CI by the SCANI_LIVE gate.
  test.skipIf(process.env.SCANI_LIVE !== '1')(
    'live sandbox returns an array shape',
    async () => {
      const apiKey = process.env.SCANI_TESTNET_GEMINI_API_KEY;
      const apiSecret = process.env.SCANI_TESTNET_GEMINI_API_SECRET;
      const baseUrl = process.env.SCANI_TESTNET_GEMINI_BASE_URL ?? 'https://api.sandbox.gemini.com';
      if (!apiKey || !apiSecret) {
        throw new Error(
          'SCANI_LIVE=1 requires SCANI_TESTNET_GEMINI_API_KEY and SCANI_TESTNET_GEMINI_API_SECRET'
        );
      }
      const provider = new GeminiProvider(passthroughLimiter(), baseUrl);
      const events = await provider.fetchTransactions({
        institutionCode: 'gemini',
        baseCurrency: { id: 'usd', symbol: 'USD' } as never,
        credentialsRef: { userId: 'live', institutionId: 'live' },
        resolveCredentials: async () => ({ apiKey, apiSecret }),
      });
      expect(Array.isArray(events)).toBe(true);
    },
    60_000
  );
});

/**
 * SC-1478. Two defects in `fetchTransactions`, found by SC-1478 and
 * fixed by SC-1480 and SC-1481.
 *
 * 1. Trade symbols are built from CURRENT balances only, so an asset that was
 *    deposited, traded and fully sold is never asked about: its trades never
 *    import, and Gemini declared no history horizon, so the import still claimed
 *    a complete history for every holding it touched. It declares one now,
 *    because a trades-only round trip still cannot be enumerated.
 * 2. Every sub-walk is `.catch(() => [])` and only page caps retract the claim,
 *    so a failed `/v2/transfers` call reads as "no deposits, complete history".
 */
describe('GeminiProvider.fetchTransactions — SC-1478', () => {
  function mockGemini(handlers: {
    balances: unknown;
    trades: (symbol: string) => unknown;
    transfers: () => Response;
  }) {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const b64 = (init?.headers as Record<string, string> | undefined)?.['X-GEMINI-PAYLOAD'];
      const payload = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : {};
      if (u.endsWith('/v1/balances'))
        return new Response(JSON.stringify(handlers.balances), { status: 200 });
      if (u.endsWith('/v1/mytrades')) {
        asked.push(payload.symbol);
        return new Response(JSON.stringify(handlers.trades(payload.symbol)), { status: 200 });
      }
      if (u.endsWith('/v2/transfers')) return handlers.transfers();
      throw new Error(`unexpected url: ${u}`);
    }) as unknown as typeof fetch;
    return asked;
  }

  const ethTrades = [
    {
      tid: 200,
      symbol: 'ethusd',
      price: '2000',
      amount: '1',
      timestamp: 1_700_000_000,
      timestampms: 1_700_000_000_000,
      type: 'Buy',
    },
    {
      tid: 201,
      symbol: 'ethusd',
      price: '2500',
      amount: '1',
      timestamp: 1_700_100_000,
      timestampms: 1_700_100_000_000,
      type: 'Sell',
    },
  ];

  test('an exited asset seen in transfers still has its trades fetched', async () => {
    const originalFetch = globalThis.fetch;
    const asked = mockGemini({
      balances: [{ currency: 'USD', amount: '1000', type: 'exchange' }],
      trades: (symbol) => (symbol === 'ethusd' ? ethTrades : []),
      transfers: () =>
        new Response(
          JSON.stringify([
            {
              type: 'Deposit',
              status: 'Complete',
              timestampms: 1_699_900_000_000,
              eid: 7,
              currency: 'ETH',
              amount: '1',
            },
          ]),
          { status: 200 }
        ),
    });
    try {
      const events = await new GeminiProvider(passthroughLimiter()).fetchTransactions(ctx as never);
      expect(asked).toContain('ethusd');
      expect(events.map((e) => e.externalId)).toContain('trade-ethusd-201');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a failed /v2/transfers walk retracts the complete-history claim', async () => {
    const originalFetch = globalThis.fetch;
    mockGemini({
      balances: [{ currency: 'ETH', amount: '1', type: 'exchange' }],
      trades: (symbol) => (symbol === 'ethusd' ? [ethTrades[0]] : []),
      transfers: () => new Response('upstream down', { status: 500 }),
    });
    const retractions: unknown[] = [];
    try {
      const events = await new GeminiProvider(passthroughLimiter()).fetchTransactions({
        ...ctx,
        retractHistoryClaim: (reason: unknown) => retractions.push(reason),
      } as never);
      expect(events.some((e) => e.externalId === 'trade-ethusd-200')).toBe(true);
      expect(retractions.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The control for SC-1481's retraction: the candidate symbols are a
 * cross-product, so most runs ask about pairs Gemini does not list. Those are
 * absent markets, not failed walks, and must not take the claim away.
 */
describe('GeminiProvider.fetchTransactions — unlisted candidate pairs', () => {
  // Gemini documents the reason, not the status, so any 4xx carrying it counts.
  test.each([400, 404])('an InvalidSymbol refusal at HTTP %d retracts nothing', async (status) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const b64 = (init?.headers as Record<string, string> | undefined)?.['X-GEMINI-PAYLOAD'];
      const payload = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : {};
      if (u.endsWith('/v1/balances')) {
        return Response.json([{ currency: 'ETH', amount: '1', type: 'exchange' }]);
      }
      if (u.endsWith('/v2/transfers')) return Response.json([]);
      if (u.endsWith('/v1/mytrades')) {
        if (payload.symbol === 'ethusd') return Response.json([]);
        return Response.json(
          { result: 'error', reason: 'InvalidSymbol', message: `Invalid symbol ${payload.symbol}` },
          { status }
        );
      }
      throw new Error(`unexpected url: ${u}`);
    }) as unknown as typeof fetch;
    const retractions: unknown[] = [];
    try {
      await new GeminiProvider(passthroughLimiter()).fetchTransactions({
        ...ctx,
        retractHistoryClaim: (r: unknown) => retractions.push(r),
      } as never);
      expect(retractions).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The other side of that control (operator review of #2122): only the
 * documented `InvalidSymbol` reason is an absent market. A 403 (bad key) or a
 * 429 (rate limit) on a candidate pair must fail the sync, never be read as
 * "this pair does not exist" and dropped. A 5xx stays a tolerated walk.
 */
describe('GeminiProvider.fetchTransactions — refusals that are not InvalidSymbol', () => {
  const mockTradesRefusal = (status: number, body: unknown) => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const b64 = (init?.headers as Record<string, string> | undefined)?.['X-GEMINI-PAYLOAD'];
      const payload = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : {};
      if (u.endsWith('/v1/balances')) {
        return Response.json([{ currency: 'ETH', amount: '1', type: 'exchange' }]);
      }
      if (u.endsWith('/v2/transfers')) return Response.json([]);
      if (u.endsWith('/v1/mytrades')) {
        if (payload.symbol === 'ethusd') return Response.json([]);
        return Response.json(body, { status });
      }
      throw new Error(`unexpected url: ${u}`);
    }) as unknown as typeof fetch;
  };

  test.each([
    [403, { result: 'error', reason: 'InvalidSignature', message: 'Invalid signature' }],
    [429, { result: 'error', reason: 'RateLimit', message: 'Requests were made too frequently' }],
  ])('a %d on a candidate pair fails the sync', async (status, body) => {
    const originalFetch = globalThis.fetch;
    mockTradesRefusal(status, body);
    try {
      await expect(
        new GeminiProvider(passthroughLimiter()).fetchTransactions(ctx as never)
      ).rejects.toThrow(String(status));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // A 5xx is retryable, so signedFetch backs off before the walk gives up: give it
  // CI's budget rather than bun's bare 5s, or a timeout leaks the fetch mock.
  test('a 500 on a candidate pair is tolerated and retracts the claim (control)', async () => {
    const originalFetch = globalThis.fetch;
    mockTradesRefusal(500, { result: 'error', reason: 'ServerError', message: 'down' });
    const retractions: unknown[] = [];
    try {
      await new GeminiProvider(passthroughLimiter()).fetchTransactions({
        ...ctx,
        retractHistoryClaim: (r: unknown) => retractions.push(r),
      } as never);
      expect(retractions.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);
});

/**
 * Even a clean run must not claim a complete history: an asset bought and sold
 * to zero without ever being deposited or withdrawn appears in no feed Gemini
 * can enumerate. The router claims completeness only for a since-less run
 * through a provider with no horizon and no retraction, so the horizon is what
 * makes it false.
 */
describe('GeminiProvider.fetchTransactions — completeness', () => {
  test('a clean since-less run does not claim a complete history', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith('/v1/balances')) {
        return Response.json([{ currency: 'ETH', amount: '1', type: 'exchange' }]);
      }
      if (u.endsWith('/v2/transfers') || u.endsWith('/v1/mytrades')) return Response.json([]);
      throw new Error(`unexpected url: ${u}`);
    }) as unknown as typeof fetch;
    const retractions: unknown[] = [];
    try {
      const provider = new GeminiProvider(passthroughLimiter());
      await provider.fetchTransactions({
        ...ctx,
        retractHistoryClaim: (r: unknown) => retractions.push(r),
      } as never);
      expect(retractions).toEqual([]);
      // Reaches back to Gemini's launch, which no account predates.
      expect(provider.transactionHistoryHorizonMs).toBeGreaterThanOrEqual(
        Date.now() - Date.UTC(2015, 9, 25) - 60_000
      );
      const claimsComplete =
        provider.transactionHistoryHorizonMs === undefined && retractions.length === 0;
      expect(claimsComplete).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
