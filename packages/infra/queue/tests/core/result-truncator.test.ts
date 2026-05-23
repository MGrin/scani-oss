import { describe, expect, test } from 'bun:test';
import { ResultTruncator } from '../../src/core/result-truncator';

// Ports the original sanitize-result.test.ts. Same class of size/
// secret-leak regressions still applies — both `user_jobs.result` jsonb
// inserts and the WS wire share the same payload.

describe('ResultTruncator', () => {
  test('returns null/undefined unchanged', () => {
    const t = new ResultTruncator();
    expect(t.truncate(null)).toBeNull();
    expect(t.truncate(undefined)).toBeUndefined();
  });

  test('small values pass through unchanged', () => {
    const t = new ResultTruncator();
    const result = { holdingsCreated: 3, errors: [] as string[] };
    expect(t.truncate(result)).toEqual(result);
  });

  test('truncates oversized top-level object fields individually', () => {
    const t = new ResultTruncator();
    const huge = 'x'.repeat(64 * 1024);
    const input = { kept: 'ok', bloated: huge };
    const out = t.truncate(input) as Record<string, unknown>;
    expect(out.kept).toBe('ok');
    expect(out.bloated).toEqual({ _truncated: true, originalBytes: expect.any(Number) });
  });

  test('reports non-serializable inputs instead of throwing', () => {
    const t = new ResultTruncator();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = t.truncate(cyclic) as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(out.reason).toBe('non-serializable');
  });

  test('top-level non-object-oversized value is truncated as a whole', () => {
    const t = new ResultTruncator();
    const huge = 'x'.repeat(64 * 1024);
    const out = t.truncate(huge) as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(out.originalBytes).toBeGreaterThan(32 * 1024);
  });

  test('honors a custom maxBytes cap', () => {
    const t = new ResultTruncator(100);
    const value = { tiny: 'ok', big: 'x'.repeat(200) };
    const out = t.truncate(value) as Record<string, unknown>;
    expect(out.tiny).toBe('ok');
    expect(out.big).toEqual({ _truncated: true, originalBytes: expect.any(Number) });
  });
});
