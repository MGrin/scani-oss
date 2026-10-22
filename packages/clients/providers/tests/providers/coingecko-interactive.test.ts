import { afterEach, describe, expect, test } from 'bun:test';
import type { OutflowPriority, OutflowRateLimiter } from '@scani/rate-limiter';
import { RateLimiterRegistry } from '../../src/core/rate-limiter-registry';
import { makeMockToken } from '../../src/core/testing';
import { CoinGeckoProvider, coingeckoFactory } from '../../src/providers/coingecko';

/**
 * SC-1766. Keyless, every CoinGecko call takes one slot every 6 s (SC-1706).
 * A user's search waited in line with background price calls, and its 3 s
 * timeout covered only the fetch: one pick (two searches) took 6 s idle and
 * hung past 30 s in E2E. The search now asks first, inside the same budget.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function answer(body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

function recording() {
  const asked: Array<{ priority: OutflowPriority | undefined; signal: boolean }> = [];
  const limiter = {
    execute: async <T>(
      fn: () => Promise<T>,
      _subKey?: string,
      signal?: AbortSignal,
      priority?: OutflowPriority
    ) => {
      asked.push({ priority, signal: signal !== undefined });
      return fn();
    },
  } as OutflowRateLimiter;
  return { limiter, asked };
}

// No slot ever frees: it gives up only when told to.
const exhausted = {
  execute: <T>(_fn: () => Promise<T>, _subKey?: string, signal?: AbortSignal) =>
    new Promise<T>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
} as OutflowRateLimiter;

describe('CoinGecko search priority (SC-1766)', () => {
  test('a search asks the shared limiter with high priority and a deadline', async () => {
    answer({ coins: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }] });
    const { limiter, asked } = recording();
    const results = await new CoinGeckoProvider(limiter).searchTokens('btc');
    expect(results[0]?.symbol).toBe('BTC');
    expect(asked).toEqual([{ priority: 'high', signal: true }]);
  });

  test('control: a price call asks with normal priority and no deadline', async () => {
    answer({ bitcoin: { usd: 1 } });
    const { limiter, asked } = recording();
    await new CoinGeckoProvider(limiter).fetchCurrentPrices(
      [
        makeMockToken({
          id: 'btc',
          symbol: 'BTC',
          providerMetadata: { coingecko: { id: 'bitcoin' } },
        }),
      ],
      { baseCurrency: makeMockToken({ id: 'usd', symbol: 'USD' }) }
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a.priority === undefined && !a.signal)).toBe(true);
  });

  test('a search with no slot free gives up within its timeout, empty', async () => {
    answer({ coins: [] });
    const started = performance.now();
    const results = await new CoinGeckoProvider(exhausted).searchTokens('btc');
    expect(results).toEqual([]);
    expect(performance.now() - started).toBeLessThan(4500);
  });

  test('there is one CoinGecko budget, never a second one beside it', async () => {
    const registry = new RateLimiterRegistry();
    await coingeckoFactory({
      redis: null,
      env: {},
      rateLimiterRegistry: registry,
      reportCredentialStatus: () => {},
    });
    expect(registry.list().map((l) => l.description)).toEqual(['CoinGecko: 1 req / 6s']);
  });
});
