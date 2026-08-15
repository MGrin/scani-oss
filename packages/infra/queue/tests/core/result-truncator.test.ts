import { describe, expect, test } from 'bun:test';
import {
  DURABLE_RESULT_MAX_BYTES,
  ResultTruncator,
  readTruncationNotice,
  TRUNCATION_ROOT_FIELD,
  WIRE_RESULT_MAX_BYTES,
} from '../../src/core/result-truncator';

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

  test('omits an oversized field rather than replacing it with another type', () => {
    const t = new ResultTruncator(WIRE_RESULT_MAX_BYTES);
    const input = { kept: 'ok', bloated: 'x'.repeat(64 * 1024) };
    const out = t.truncate(input) as Record<string, unknown>;
    expect(out.kept).toBe('ok');
    expect('bloated' in out).toBe(false);
    expect(readTruncationNotice(out)).toEqual({
      omittedFields: ['bloated'],
      originalBytes: expect.any(Number),
    });
  });

  // SC-145: the whole point. A reader that branches on `Array.isArray`
  // took a wrong branch — and asserted a cause that never happened —
  // because an over-budget array came back as an object.
  test('never hands back an array field as a differently-typed value', () => {
    const t = new ResultTruncator(WIRE_RESULT_MAX_BYTES);
    const chains = Array.from({ length: 3000 }, (_, i) => ({ id: `token-${i}`, balance: '1.0' }));
    const out = t.truncate({ needsReview: true, chains }) as Record<string, unknown>;
    expect(out.chains).toBeUndefined();
    expect(Array.isArray(out.chains)).toBe(false);
    expect(readTruncationNotice(out)?.omittedFields).toContain('chains');
  });

  test('reports non-serializable inputs instead of throwing', () => {
    const t = new ResultTruncator();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = t.truncate(cyclic);
    expect(readTruncationNotice(out)?.omittedFields).toEqual([TRUNCATION_ROOT_FIELD]);
  });

  test('top-level non-object-oversized value is reported as a whole', () => {
    const t = new ResultTruncator(WIRE_RESULT_MAX_BYTES);
    const out = t.truncate('x'.repeat(64 * 1024));
    const notice = readTruncationNotice(out);
    expect(notice?.omittedFields).toEqual([TRUNCATION_ROOT_FIELD]);
    expect(notice?.originalBytes).toBeGreaterThan(WIRE_RESULT_MAX_BYTES);
  });

  test('honors a custom maxBytes cap', () => {
    const t = new ResultTruncator(100);
    const out = t.truncate({ tiny: 'ok', big: 'x'.repeat(200) }) as Record<string, unknown>;
    expect(out.tiny).toBe('ok');
    expect('big' in out).toBe(false);
  });

  // A busy Solana wallet serialises to ~300 bytes per candidate. The
  // durable budget has to clear that or the review list is unreachable
  // and the import can never be confirmed.
  test('the durable budget carries a real wallet-review payload intact', () => {
    const chains = [
      {
        institutionId: 'inst-1',
        snapshots: Array.from({ length: 2766 }, (_, i) => ({
          externalId: `So1111111111111111111111111111111111111111${i}`,
          balance: '123.456789',
          capturedAt: '2026-08-14T12:00:00.000Z',
          tokenIdentity: { symbol: `TK${i}`, name: `Token number ${i}`, decimals: 9 },
        })),
      },
    ];
    const input = { needsReview: true, chains, candidateCount: 2766 };
    expect(JSON.stringify(input).length).toBeGreaterThan(WIRE_RESULT_MAX_BYTES);

    const durable = new ResultTruncator(DURABLE_RESULT_MAX_BYTES).truncate(input) as Record<
      string,
      unknown
    >;
    expect(durable).toEqual(input);
    expect(readTruncationNotice(durable)).toBeNull();
  });

  test('readTruncationNotice is null for an untruncated result', () => {
    expect(readTruncationNotice({ ok: true })).toBeNull();
    expect(readTruncationNotice(null)).toBeNull();
    expect(readTruncationNotice('nope')).toBeNull();
  });
});
