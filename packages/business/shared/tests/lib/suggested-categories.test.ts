import { describe, expect, test } from 'bun:test';
import { SUGGESTED_CATEGORIES, SUGGESTED_CATEGORY_KEYS } from '../../src/lib/suggested-categories';

describe('SUGGESTED_CATEGORIES (SC-1652)', () => {
  test('is 8 parents and 10 children, as the spec lists them', () => {
    expect(SUGGESTED_CATEGORIES).toHaveLength(8);
    expect(SUGGESTED_CATEGORIES.flatMap((c) => c.children)).toHaveLength(10);
    expect(SUGGESTED_CATEGORIES.map((c) => c.key)).toEqual([
      'income',
      'housing',
      'food',
      'transport',
      'health',
      'shopping',
      'travel',
      'fees',
    ]);
    expect(SUGGESTED_CATEGORY_KEYS).toHaveLength(18);
  });
});
