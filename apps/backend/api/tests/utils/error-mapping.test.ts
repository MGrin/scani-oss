import { describe, expect, test } from 'bun:test';
import { ExpiredCredentialsError } from '@scani/domain/services';
import { TRPCError } from '@trpc/server';
import { toTRPCError } from '../../src/utils/error-mapping';

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
