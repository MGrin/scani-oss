import { describe, expect, test } from 'bun:test';
import { ExpiredCredentialsError } from '@scani/domain/services';
import { ProviderError } from '@scani/providers/core/errors';
import { TRPCError } from '@trpc/server';
import { toCredentialCheckError, toTRPCError } from '../../src/utils/error-mapping';

const ctx = {
  fallbackCode: 'BAD_REQUEST' as const,
  fallbackMessage: 'Upstream rejected the request',
};

describe('toTRPCError', () => {
  test('passes an existing TRPCError through unchanged', () => {
    const original = new TRPCError({ code: 'CONFLICT', message: 'already exists' });
    const out = toTRPCError(original, ctx);
    expect(out).toBe(original);
  });

  test('maps ExpiredCredentialsError to UNAUTHORIZED', () => {
    const err = new ExpiredCredentialsError('user-1', 'inst-1', new Date('2026-01-01'));
    const out = toTRPCError(err, ctx);
    expect(out.code).toBe('UNAUTHORIZED');
    expect(out.message).toMatch(/expired/i);
    expect(out.cause).toBe(err);
  });

  test('status 401 → UNAUTHORIZED', () => {
    const out = toTRPCError({ status: 401, message: 'forbidden' }, ctx);
    expect(out.code).toBe('UNAUTHORIZED');
  });

  test('status 403 → UNAUTHORIZED', () => {
    const out = toTRPCError({ status: 403, message: 'no' }, ctx);
    expect(out.code).toBe('UNAUTHORIZED');
  });

  test('message containing "unauthorized" → UNAUTHORIZED', () => {
    const out = toTRPCError({ message: 'Provider returned UNAUTHORIZED' }, ctx);
    expect(out.code).toBe('UNAUTHORIZED');
  });

  test('status 429 → TOO_MANY_REQUESTS', () => {
    const out = toTRPCError({ status: 429, message: 'slow down' }, ctx);
    expect(out.code).toBe('TOO_MANY_REQUESTS');
  });

  test('message containing "rate limit" → TOO_MANY_REQUESTS', () => {
    const out = toTRPCError({ message: 'rate limit exceeded' }, ctx);
    expect(out.code).toBe('TOO_MANY_REQUESTS');
  });

  test('message containing "too many requests" → TOO_MANY_REQUESTS', () => {
    const out = toTRPCError({ message: 'Too many requests' }, ctx);
    expect(out.code).toBe('TOO_MANY_REQUESTS');
  });

  test('Node ETIMEDOUT code → TIMEOUT', () => {
    const out = toTRPCError({ code: 'ETIMEDOUT', message: 'request stalled' }, ctx);
    expect(out.code).toBe('TIMEOUT');
  });

  test('UND_ERR_CONNECT_TIMEOUT → TIMEOUT', () => {
    const out = toTRPCError({ code: 'UND_ERR_CONNECT_TIMEOUT', message: 'connect' }, ctx);
    expect(out.code).toBe('TIMEOUT');
  });

  test('message containing "timeout" → TIMEOUT', () => {
    const out = toTRPCError({ message: 'Connection timeout after 30s' }, ctx);
    expect(out.code).toBe('TIMEOUT');
  });

  test('message containing "timed out" → TIMEOUT', () => {
    const out = toTRPCError({ message: 'Request timed out' }, ctx);
    expect(out.code).toBe('TIMEOUT');
  });

  test('status 500 → INTERNAL_SERVER_ERROR', () => {
    const out = toTRPCError({ status: 500, message: 'oops' }, ctx);
    expect(out.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('status 502 → INTERNAL_SERVER_ERROR', () => {
    const out = toTRPCError({ status: 502, message: 'bad gateway' }, ctx);
    expect(out.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('status 503 → INTERNAL_SERVER_ERROR', () => {
    const out = toTRPCError({ status: 503, message: 'unavailable' }, ctx);
    expect(out.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('ECONNRESET → INTERNAL_SERVER_ERROR', () => {
    const out = toTRPCError({ code: 'ECONNRESET', message: 'reset' }, ctx);
    expect(out.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('ECONNREFUSED → INTERNAL_SERVER_ERROR', () => {
    const out = toTRPCError({ code: 'ECONNREFUSED', message: 'refused' }, ctx);
    expect(out.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('falls back to provided code when nothing matches', () => {
    const out = toTRPCError({ message: 'something went sideways' }, ctx);
    expect(out.code).toBe('BAD_REQUEST');
    expect(out.message).toBe('Upstream rejected the request');
  });

  test('preserves the original error as `cause`', () => {
    const err = new Error('orig');
    const out = toTRPCError(err, ctx);
    expect(out.cause).toBe(err);
  });
});

/**
 * The connect form's only sentence, and what decides which one it is
 * (SC-445).
 *
 * `BAD_REQUEST` is "these details were rejected" — the reader's next move is
 * to go back to the venue and issue new keys. Every other code says we could
 * not reach a verdict, which is the truth about a 5xx, a timeout, a rate
 * limit and a report the venue has not finished generating. Sending someone
 * to reissue keys over those is the defect; on a venue that counts failed
 * attempts it is also what sustains the lockout (SC-279).
 */
describe('toCredentialCheckError', () => {
  test('auth-failed is the only provider kind that blames the credential', () => {
    const err = new ProviderError('kraken HTTP 401 — EAPI:Invalid key', 'auth-failed', 'kraken');
    const out = toCredentialCheckError(err, 'Kraken');
    expect(out.code).toBe('BAD_REQUEST');
    expect(out.message).toContain('EAPI:Invalid key');
    expect(out.cause).toBe(err);
  });

  test('rate-limited asks for a pause, not for new keys', () => {
    const err = new ProviderError('IBKR Flex Query error (code 1025)', 'rate-limited', 'ibkr', {
      retryAfterMs: 86_400_000,
    });
    const out = toCredentialCheckError(err, 'Interactive Brokers');
    expect(out.code).toBe('TOO_MANY_REQUESTS');
    expect(out.message).not.toMatch(/invalid|rejected/i);
  });

  test('retryable — a report still generating — says we could not check', () => {
    const err = new ProviderError(
      'IBKR SendRequest still transient after 6 retries',
      'retryable',
      'ibkr'
    );
    const out = toCredentialCheckError(err, 'Interactive Brokers');
    expect(out.code).toBe('INTERNAL_SERVER_ERROR');
    expect(out.message).toBe("Couldn't reach Interactive Brokers to check these credentials");
  });

  test('unrecoverable keeps the provider’s own words — the operand is in them', () => {
    const err = new ProviderError('IBKR Flex Query error (code 1003)', 'unrecoverable', 'ibkr');
    const out = toCredentialCheckError(err, 'Interactive Brokers');
    expect(out.code).toBe('BAD_REQUEST');
    expect(out.message).toContain('1003');
  });

  test('a timeout is a timeout, not a rejection', () => {
    const out = toCredentialCheckError(new Error('request timed out'), 'Wise');
    expect(out.code).toBe('TIMEOUT');
  });

  test('an unclassified throw stops falling through to BAD_REQUEST', () => {
    const out = toCredentialCheckError(new Error('socket hang up'), 'Binance');
    expect(out.code).toBe('INTERNAL_SERVER_ERROR');
    expect(out.message).toBe("Couldn't reach Binance to check these credentials");
  });

  test('an existing TRPCError passes through', () => {
    const original = new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'slow down' });
    expect(toCredentialCheckError(original, 'Kraken')).toBe(original);
  });
});
