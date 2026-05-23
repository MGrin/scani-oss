import { describe, expect, test } from 'bun:test';
import { sanitizeResult } from '../src/sanitize-result';

// Mirrors the backend's summarize-payload test. This copy protects the
// worker-side write path into `user_jobs.result` from the same class of
// size/secret regressions — the two files must agree on behaviour since
// they both feed the same DB column.

describe('worker sanitizeResult', () => {
  test('returns null/undefined unchanged', () => {
    expect(sanitizeResult('wallet-import', null)).toBeNull();
    expect(sanitizeResult('wallet-import', undefined)).toBeUndefined();
  });

  test('small values pass through unchanged', () => {
    const result = { holdingsCreated: 3, errors: [] as string[] };
    expect(sanitizeResult('wallet-import', result)).toEqual(result);
  });

  test('truncates oversized top-level object fields individually', () => {
    const huge = 'x'.repeat(64 * 1024);
    const input = { kept: 'ok', bloated: huge };
    const out = sanitizeResult('wallet-import', input) as Record<string, unknown>;
    expect(out.kept).toBe('ok');
    expect(out.bloated).toEqual({ _truncated: true, originalBytes: expect.any(Number) });
  });

  test('reports non-serializable inputs instead of throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = sanitizeResult('wallet-import', cyclic) as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(out.reason).toBe('non-serializable');
  });

  test('top-level non-object-oversized value is truncated as a whole', () => {
    const huge = 'x'.repeat(64 * 1024);
    const out = sanitizeResult('wallet-import', huge) as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(out.originalBytes).toBeGreaterThan(32 * 1024);
  });
});
