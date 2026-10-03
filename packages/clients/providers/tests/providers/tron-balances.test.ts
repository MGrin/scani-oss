import { afterEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { ProviderError } from '../../src/core/errors';
import { RateLimiterRegistry } from '../../src/core/rate-limiter-registry';
import { TronProvider, tronFactory } from '../../src/providers/tron';

/**
 * SC-1524. A Tron wallet holding TRX and USDT read as "Tokens
 * found 0" with no error, for two reasons that compounded:
 *
 *  - TRC-20 balances were read from `/v1/accounts/{addr}/tokens`, which is a
 *    404 on TronGrid. They are in the account body's `data[0].trc20`, as
 *    `{ contract: rawAmount }` pairs with no decimals — those come from
 *    `/v1/trc20/info`, at most 20 contracts per request.
 *  - Every non-2xx response read as null and null read as "no tokens", so a
 *    429 from keyless TronGrid (1 req/s) became an empty wallet.
 */

const WALLET = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const ctx = {
  institutionCode: 'tron',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ walletAddress: WALLET }),
};

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Records every URL; anything the handler does not answer is TronGrid's 404. */
function mockTronGrid(handler: (url: URL) => Response | undefined): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string) => {
    seen.push(String(input));
    return (
      handler(new URL(String(input))) ??
      Response.json({ success: false, error: 'Not Found', statusCode: 404 }, { status: 404 })
    );
  }) as unknown as typeof fetch;
  return seen;
}

function accountBody(trc20: Array<Record<string, string>>) {
  return Response.json({
    data: [{ address: '41a0', balance: 2_500_500_000, trc20 }],
    success: true,
    meta: { at: 1, page_size: 1 },
  });
}

function infoBody(contracts: string[]) {
  return Response.json({
    data: contracts.map((c) => ({
      contract_address: c,
      symbol: c === USDT ? 'USDT' : `T${c.slice(1, 5)}`,
      name: c === USDT ? 'Tether USD' : 'Token',
      decimals: '6',
      type: 'trc20',
    })),
    success: true,
  });
}

describe('TronProvider.fetchBalances reads TRC-20 from the account (SC-1524)', () => {
  test('USDT comes from data[0].trc20, priced by /v1/trc20/info decimals', async () => {
    const seen = mockTronGrid((url) => {
      if (url.pathname === `/v1/accounts/${WALLET}`) {
        return accountBody([{ [USDT]: '1250250000' }]);
      }
      if (url.pathname === '/v1/trc20/info') {
        return infoBody((url.searchParams.get('contract_list') ?? '').split(','));
      }
      return undefined;
    });

    const out = await new TronProvider(passthroughLimiter(), 'http://api').fetchBalances(
      ctx as never
    );

    const trx = out.find((h) => h.externalId === 'native');
    const usdt = out.find((h) => h.externalId === USDT);
    expect(trx?.balance).toBe('2500.5');
    expect(usdt?.balance).toBe('1250.25');
    expect(usdt?.tokenIdentity).toMatchObject({
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      providerMetadata: { tron: { contract: USDT } },
    });
    expect(seen.some((u) => u.includes('/tokens'))).toBe(false);
    expect(seen.filter((u) => new URL(u).pathname === `/v1/accounts/${WALLET}`)).toHaveLength(1);
  });

  test('metadata is asked for in batches of 20, and only for non-zero balances', async () => {
    const held = Array.from({ length: 25 }, (_, i) => `T${String(i).padStart(33, 'A')}`);
    const batches: string[][] = [];
    mockTronGrid((url) => {
      if (url.pathname === `/v1/accounts/${WALLET}`) {
        return accountBody([
          ...held.map((c) => ({ [c]: '1000000' })),
          { TZeroZeroZeroZeroZeroZeroZeroZero1: '0' },
        ]);
      }
      if (url.pathname === '/v1/trc20/info') {
        const batch = (url.searchParams.get('contract_list') ?? '').split(',');
        batches.push(batch);
        return infoBody(batch);
      }
      return undefined;
    });

    const out = await new TronProvider(passthroughLimiter(), 'http://api').fetchBalances(
      ctx as never
    );

    expect(batches.map((b) => b.length)).toEqual([20, 5]);
    expect(batches.flat()).not.toContain('TZeroZeroZeroZeroZeroZeroZeroZero1');
    expect(out.filter((h) => h.externalId !== 'native')).toHaveLength(25);
  });
});

describe('a failed TronGrid read is an error, never an empty wallet (SC-1524)', () => {
  const cases = [
    [429, 'rate-limited'],
    [503, 'retryable'],
    [404, 'unrecoverable'],
  ] as const;

  for (const [status, kind] of cases) {
    test(`HTTP ${status} on the account read throws ProviderError(${kind})`, async () => {
      mockTronGrid(() => new Response('{"Error":"refused"}', { status }));
      const read = new TronProvider(passthroughLimiter(), 'http://api').fetchBalances(ctx as never);
      const err = await read.then(
        (holdings) => holdings,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe(kind);
      expect((err as ProviderError).status).toBe(status);
    });
  }

  test('a 429 on the TRC-20 metadata read throws too', async () => {
    mockTronGrid((url) => {
      if (url.pathname === `/v1/accounts/${WALLET}`) {
        return accountBody([{ [USDT]: '1250250000' }]);
      }
      if (url.pathname === '/v1/trc20/info') {
        return new Response('{"Error":"exceeded the allowed_rps(1)"}', { status: 429 });
      }
      return undefined;
    });
    const err = await new TronProvider(passthroughLimiter(), 'http://api')
      .fetchBalances(ctx as never)
      .then(
        (holdings) => holdings,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('rate-limited');
  });

  test('the activity probe classifies a 429 as rate-limited', async () => {
    mockTronGrid(() => new Response('{"Error":"exceeded the allowed_rps(1)"}', { status: 429 }));
    const err = await new TronProvider(passthroughLimiter(), 'http://api')
      .hasActivity(WALLET, 'tron', {} as never)
      .then(
        (active) => active,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('rate-limited');
  });
});

describe('tronFactory limits to what TronGrid allows (SC-1524)', () => {
  async function bootLimiter(env: Record<string, string>): Promise<OutflowRateLimiter> {
    const registry = new RateLimiterRegistry();
    await tronFactory({
      redis: null,
      env,
      rateLimiterRegistry: registry,
      reportCredentialStatus: () => {},
    });
    const limiter = registry.get('tron');
    if (!limiter) throw new Error('tronFactory registered no tron limiter');
    return limiter;
  }

  test('keyless: one request per second', async () => {
    const limiter = await bootLimiter({});
    expect((await limiter.tryConsume()).ok).toBe(true);
    expect((await limiter.tryConsume()).ok).toBe(false);
  });

  test('with TRON_PRO_API_KEY: more than one per second', async () => {
    const limiter = await bootLimiter({ TRON_PRO_API_KEY: 'k' });
    expect((await limiter.tryConsume()).ok).toBe(true);
    expect((await limiter.tryConsume()).ok).toBe(true);
  });
});
