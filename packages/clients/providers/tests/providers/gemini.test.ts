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
      )) as typeof fetch;
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
    globalThis.fetch = (async () => new Response('[]', { status: 200 })) as typeof fetch;
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
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
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
    }) as typeof fetch;

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
    }) as typeof fetch;

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
    }) as typeof fetch;

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
    }) as typeof fetch;

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
