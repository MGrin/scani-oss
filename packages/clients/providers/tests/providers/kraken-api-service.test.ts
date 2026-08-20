import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { ProviderError } from '../../src/core/errors';
import { KrakenApiService } from '../../src/providers/kraken/api-service';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

/** A base64 secret Kraken would accept, so the shape guard is not what fires. */
const SECRET = Buffer.from('kraken-test-secret').toString('base64');

function withFetch<T>(impl: typeof fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return body().finally(() => {
    globalThis.fetch = original;
  });
}

function krakenError(...errors: string[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ error: errors, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/**
 * Kraken's `error` array, classified rather than pasted (SC-445).
 *
 * `validateApiKey` is the one endpoint here whose caller has to tell a reader
 * either "Kraken refused these keys" or "we could not reach Kraken", and
 * `EAPI:Invalid key` and `EService:Unavailable` are indistinguishable once
 * they are both a string on an `Error`.
 */
describe('KrakenApiService.validateApiKey', () => {
  test('a rejected request is auth-failed — /private/Balance takes no arguments to get wrong', async () => {
    const api = new KrakenApiService('https://api.kraken.test', passthroughLimiter());
    const thrown = await withFetch(krakenError('EAPI:Invalid key'), () =>
      api
        .validateApiKey('k', SECRET)
        .then(() => null)
        .catch((err: unknown) => err)
    );
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).kind).toBe('auth-failed');
    expect((thrown as Error).message).toContain('EAPI:Invalid key');
  });

  test('EService is Kraken talking about itself, not about the key', async () => {
    const api = new KrakenApiService('https://api.kraken.test', passthroughLimiter());
    const thrown = await withFetch(krakenError('EService:Unavailable'), () =>
      api
        .validateApiKey('k', SECRET)
        .then(() => null)
        .catch((err: unknown) => err)
    );
    expect((thrown as ProviderError).kind).toBe('retryable');
  });

  test('a rate limit is a rate limit', async () => {
    const api = new KrakenApiService('https://api.kraken.test', passthroughLimiter());
    const thrown = await withFetch(krakenError('EAPI:Rate limit exceeded'), () =>
      api
        .validateApiKey('k', SECRET)
        .then(() => null)
        .catch((err: unknown) => err)
    );
    expect((thrown as ProviderError).kind).toBe('rate-limited');
  });

  test('a 5xx is retryable, so nobody is told to reissue keys over an outage', async () => {
    const api = new KrakenApiService('https://api.kraken.test', passthroughLimiter());
    const thrown = await withFetch(
      (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch,
      () =>
        api
          .validateApiKey('k', SECRET)
          .then(() => null)
          .catch((err: unknown) => err)
    );
    expect((thrown as ProviderError).kind).toBe('retryable');
  });

  test('a secret that is not base64 is a verdict — it never reaches Kraken', async () => {
    const api = new KrakenApiService('https://api.kraken.test', passthroughLimiter());
    const thrown = await api
      .validateApiKey('k', '')
      .then(() => null)
      .catch((err: unknown) => err);
    expect((thrown as ProviderError).kind).toBe('auth-failed');
    expect((thrown as Error).message).toContain('base64');
  });
});
