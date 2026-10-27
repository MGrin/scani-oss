import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { STALE_REFETCH_MAX, STALE_REFETCH_MS, whileStale } from '../../../src/v3/lib/returns-stale';

// SC-1745: after a write the API answers with the last returns at once, marked
// stale, and computes the current ones. Home re-asks until it has them, and
// stops re-asking when a compute keeps failing.
const query = (dataUpdateCount = 1) => ({ state: { dataUpdateCount } });

describe('whileStale (SC-1745)', () => {
  test('a stale answer is asked for again shortly', () => {
    expect(whileStale({ stale: true }, query())).toBe(STALE_REFETCH_MS);
  });

  test('a current answer is not asked for again', () => {
    expect(whileStale({ stale: false }, query())).toBe(false);
  });

  test('no answer yet starts no polling', () => {
    expect(whileStale(undefined, query())).toBe(false);
  });

  test('a stale answer that never turns current stops being asked for', () => {
    expect(whileStale({ stale: true }, query(STALE_REFETCH_MAX))).toBe(STALE_REFETCH_MS);
    expect(whileStale({ stale: true }, query(STALE_REFETCH_MAX + 1))).toBe(false);
  });
});
