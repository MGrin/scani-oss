import { describe, expect, test } from 'bun:test';
import { classifyError, ProviderError } from '../../src/core/errors';

describe('ProviderError', () => {
  test('preserves kind + providerKey + cause', () => {
    const cause = new Error('upstream went boom');
    const err = new ProviderError('msg', 'rate-limited', 'coingecko', { cause });
    expect(err.kind).toBe('rate-limited');
    expect(err.providerKey).toBe('coingecko');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('ProviderError');
  });

  test('fromHttp maps 401 / 403 to auth-failed', () => {
    const err = ProviderError.fromHttp('binance', new Response(null, { status: 401 }));
    expect(err.kind).toBe('auth-failed');
    expect(err.providerKey).toBe('binance');
    expect(err.message).toContain('binance HTTP 401');
  });

  test('fromHttp maps 429 to rate-limited', () => {
    const err = ProviderError.fromHttp('coingecko', new Response(null, { status: 429 }));
    expect(err.kind).toBe('rate-limited');
  });

  test('fromHttp maps 5xx to retryable', () => {
    const err = ProviderError.fromHttp('finnhub', new Response(null, { status: 503 }));
    expect(err.kind).toBe('retryable');
  });

  test('fromHttp maps other 4xx to unrecoverable', () => {
    const err = ProviderError.fromHttp('finnhub', new Response(null, { status: 422 }));
    expect(err.kind).toBe('unrecoverable');
  });

  test('fromHttp truncates long bodies in message', () => {
    const big = 'x'.repeat(500);
    const err = ProviderError.fromHttp('x', new Response(null, { status: 500 }), big);
    expect(err.message.length).toBeLessThan(big.length + 100);
  });
});

describe('classifyError', () => {
  test('returns existing kind for ProviderError', () => {
    expect(classifyError(new ProviderError('m', 'unrecoverable'))).toBe('unrecoverable');
  });

  test('catches HTTP 429 in messages', () => {
    expect(classifyError(new Error('boom HTTP 429'))).toBe('rate-limited');
  });

  test('catches Kraken EAPI rate limit', () => {
    expect(classifyError(new Error('EAPI:Rate limit exceeded'))).toBe('rate-limited');
  });

  test('catches Kraken EAPI auth errors', () => {
    expect(classifyError(new Error('EAPI:Invalid signature'))).toBe('auth-failed');
    expect(classifyError(new Error('EAPI:Invalid key'))).toBe('auth-failed');
  });

  test('catches HTTP 401 / 403 as auth-failed', () => {
    expect(classifyError(new Error('HTTP 401'))).toBe('auth-failed');
    expect(classifyError(new Error('HTTP 403 Forbidden'))).toBe('auth-failed');
  });

  test('catches HTTP 5xx + network errors as retryable', () => {
    expect(classifyError(new Error('HTTP 500'))).toBe('retryable');
    expect(classifyError(new Error('ECONNRESET'))).toBe('retryable');
    expect(classifyError(new Error('fetch failed'))).toBe('retryable');
  });

  test('catches IBKR Flex Query auth + rate-limit codes', () => {
    expect(classifyError(new Error('IBKR Flex Query error (code 1010)'))).toBe('auth-failed');
    expect(classifyError(new Error('IBKR Flex Query error (code 1018)'))).toBe('rate-limited');
  });

  test('defaults unknown errors to retryable', () => {
    expect(classifyError(new Error('something weird'))).toBe('retryable');
    expect(classifyError('a string')).toBe('retryable');
  });
});
