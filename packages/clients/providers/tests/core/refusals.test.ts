import { describe, expect, test } from 'bun:test';
import { lastRefusal, recordRefusal } from '../../src/core/refusals';

describe('refusals (SC-1602)', () => {
  test('the last refusal is kept per provider', () => {
    recordRefusal('zz-probe', 1_000);
    recordRefusal('zz-probe', 2_000);
    expect(lastRefusal('zz-probe')).toBe(2_000);
    expect(lastRefusal('zz-never')).toBeUndefined();
  });
});
