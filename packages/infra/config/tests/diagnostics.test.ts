import { describe, expect, test } from 'bun:test';
import { diagnosticsAuthorized, publicHealthBody } from '../src/index';

const TOKEN = 'd'.repeat(48);

function req(authorization?: string): Request {
  return new Request('http://x/health/deep', {
    headers: authorization ? { authorization } : {},
  });
}

describe('diagnosticsAuthorized (SC-1357)', () => {
  test('accepts the configured bearer', () => {
    expect(diagnosticsAuthorized(req(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
  });

  test('refuses no header, a wrong token, and a prefix of the right one', () => {
    expect(diagnosticsAuthorized(req(), TOKEN)).toBe(false);
    expect(diagnosticsAuthorized(req(`Bearer ${'e'.repeat(48)}`), TOKEN)).toBe(false);
    expect(diagnosticsAuthorized(req(`Bearer ${TOKEN.slice(0, 20)}`), TOKEN)).toBe(false);
    expect(diagnosticsAuthorized(req(TOKEN), TOKEN)).toBe(false);
  });

  test('refuses everything when no token is configured, including an empty bearer', () => {
    expect(diagnosticsAuthorized(req('Bearer '), undefined)).toBe(false);
    expect(diagnosticsAuthorized(req('Bearer '), '')).toBe(false);
    expect(diagnosticsAuthorized(req(`Bearer ${TOKEN}`), undefined)).toBe(false);
  });
});

describe('publicHealthBody (SC-1357)', () => {
  const full = {
    status: 'degraded',
    timestamp: '2026-09-27T00:00:00.000Z',
    checks: {
      db: {
        ok: false,
        error: 'password authentication failed for user "neondb_owner"',
        latencyMs: 12,
      },
      redis: { ok: true, latencyMs: 3 },
      redisReachability: {
        ok: false,
        nameResolutionFailure: true,
        error:
          'host does not resolve from this machine for 9000ms (4 attempts) — will not self-heal',
      },
    },
    indexes: { detail: ['CREATE INDEX ...'] },
    providerCredentials: { unkeyed: ['COINGECKO_API_KEY'] },
    poolConfig: { max: 20 },
  };

  test('keeps the status, the timestamp and each check as a boolean', () => {
    expect(publicHealthBody(full)).toEqual({
      status: 'degraded',
      timestamp: '2026-09-27T00:00:00.000Z',
      checks: {
        db: { ok: false },
        redis: { ok: true },
        redisReachability: { ok: false, nameResolutionFailure: true },
      },
    });
  });

  test('carries no error text, provider names, index definitions or pool config', () => {
    const text = JSON.stringify(publicHealthBody(full));
    for (const leak of [
      'neondb_owner',
      'COINGECKO',
      'CREATE INDEX',
      'poolConfig',
      'latencyMs',
      'resolve',
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  test('keeps a top-level boolean ok, which the api reads from /health/r2', () => {
    expect(
      publicHealthBody({ ok: false, latencyMs: 40, error: 'NoSuchBucket: scani-prod' })
    ).toEqual({ ok: false });
    expect(publicHealthBody({ ok: true, latencyMs: 40 })).toEqual({ ok: true });
  });

  test('a body with no checks keeps only what it has', () => {
    expect(publicHealthBody({ status: 'ok', ready: true, error: 'boom' })).toEqual({
      status: 'ok',
    });
  });
});
