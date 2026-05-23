import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import {
  type ApiKeyCreds,
  BaseHmacCexProvider,
  type SignedRequest,
} from '../../../src/core/base/base-hmac-cex-provider';
import type { Capability } from '../../../src/core/capabilities';
import { ProviderError } from '../../../src/core/errors';

// Pass-through limiter — fn called immediately, no Redis.
function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

// Minimal subclass for testing the base in isolation. Stubs `signRequest`
// to deterministic headers so tests assert on the wiring, not on
// per-venue signing math.
class TestProvider extends BaseHmacCexProvider {
  readonly providerKey = 'test';
  readonly capabilities: readonly Capability[] = [];
  protected readonly baseUrl = 'https://api.test.example';

  protected signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    const sig = crypto
      .createHmac('sha256', creds.apiSecret)
      .update(`${req.method}${req.url}${req.body ?? ''}`)
      .digest('hex');
    return {
      'X-Api-Key': creds.apiKey,
      'X-Api-Sign': sig,
    };
  }
}

describe('BaseHmacCexProvider', () => {
  test('signedFetch attaches subclass headers + extraHeaders + builds URL with query', async () => {
    const limiter = passthroughLimiter();
    const provider = new TestProvider(limiter);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;

    try {
      await provider.signedFetch(
        {
          method: 'GET',
          url: '/v1/balances',
          query: 'foo=bar',
          extraHeaders: { 'Content-Type': 'application/json' },
        },
        { apiKey: 'k', apiSecret: 's' }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test.example/v1/balances?foo=bar');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('k');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Api-Sign']).toBeDefined();
  });

  test('signedFetch wraps non-2xx as ProviderError with the right kind', async () => {
    const provider = new TestProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Forbidden', { status: 403 })) as typeof fetch;
    try {
      await expect(
        provider.signedFetch({ method: 'GET', url: '/x' }, { apiKey: 'k', apiSecret: 's' })
      ).rejects.toMatchObject({
        kind: 'auth-failed',
        providerKey: 'test',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('signedFetch wraps 5xx as retryable ProviderError', async () => {
    const provider = new TestProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('boom', { status: 503 })) as typeof fetch;
    try {
      await expect(
        provider.signedFetch({ method: 'GET', url: '/x' }, { apiKey: 'k', apiSecret: 's' })
      ).rejects.toMatchObject({ kind: 'retryable' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('signedJson parses the response body', async () => {
    const provider = new TestProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ value: 42 }), { status: 200 })) as typeof fetch;
    try {
      const data = await provider.signedJson<{ value: number }>(
        { method: 'GET', url: '/x' },
        { apiKey: 'k', apiSecret: 's' }
      );
      expect(data.value).toBe(42);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('resolveApiCreds returns null when apiKey or apiSecret missing', async () => {
    const provider = new TestProvider(passthroughLimiter());
    const ctx = {
      baseCurrency: { id: 'b', symbol: 'USD' } as never,
      credentialsRef: { userId: 'u', institutionId: 'i' },
      resolveCredentials: async () => ({}) as Record<string, unknown>,
    };
    expect(await provider.resolveApiCreds(ctx as never)).toBeNull();
  });

  test('resolveApiCreds returns the typed creds when both fields present', async () => {
    const provider = new TestProvider(passthroughLimiter());
    const ctx = {
      baseCurrency: { id: 'b', symbol: 'USD' } as never,
      credentialsRef: { userId: 'u', institutionId: 'i' },
      resolveCredentials: async () => ({
        apiKey: 'k',
        apiSecret: 's',
        passphrase: 'p',
      }),
    };
    const creds = await provider.resolveApiCreds(ctx as never);
    expect(creds).toEqual({ apiKey: 'k', apiSecret: 's', passphrase: 'p' });
  });

  test('signRequest produces a deterministic signature for the same inputs', () => {
    const provider = new TestProvider(passthroughLimiter());
    const a = provider.signRequest({ method: 'GET', url: '/x' }, { apiKey: 'k', apiSecret: 's' });
    const b = provider.signRequest({ method: 'GET', url: '/x' }, { apiKey: 'k', apiSecret: 's' });
    expect(a['X-Api-Sign']).toBe(b['X-Api-Sign']);
  });

  test('ProviderError.fromHttp message includes truncated body', () => {
    const big = 'x'.repeat(500);
    const err = ProviderError.fromHttp('test', new Response(null, { status: 500 }), big);
    expect(err.message).toContain('test HTTP 500');
    expect(err.message.length).toBeLessThan(big.length + 100);
  });
});
