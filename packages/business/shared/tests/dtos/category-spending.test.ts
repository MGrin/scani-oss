import { describe, expect, test } from 'bun:test';
import { categorySpendingInputSchema } from '../../src/dtos/category-spending';

describe('category spending input', () => {
  test('accepts bounded UTC months and refuses unknown nested scope', () => {
    expect(categorySpendingInputSchema.parse({ month: '1900-01' })).toEqual({ month: '1900-01' });
    for (const month of ['1899-12', '2026-00', '2026-13', '9999-12', '2026-1']) {
      expect(categorySpendingInputSchema.safeParse({ month }).success).toBe(false);
    }
    const detail = { tokenId: crypto.randomUUID(), category: 'all', offset: 0 };
    expect(categorySpendingInputSchema.safeParse({ month: '2026-01', detail }).success).toBe(true);
    expect(
      categorySpendingInputSchema.safeParse({
        month: '2026-01',
        detail: { ...detail, search: 'x' },
      }).success
    ).toBe(false);
    expect(
      categorySpendingInputSchema.safeParse({ month: '2026-01', detail: { ...detail, offset: -1 } })
        .success
    ).toBe(false);
    expect(
      categorySpendingInputSchema.safeParse({ month: '2026-01', userId: crypto.randomUUID() })
        .success
    ).toBe(false);
  });
  test('normalizes UUID selector case so valid deep links match response identities', () => {
    const upper = `a${crypto.randomUUID().slice(1)}`.toUpperCase();
    const parsed = categorySpendingInputSchema.parse({
      month: '2026-01',
      accountId: upper,
      detail: { tokenId: upper, category: upper, offset: 0 },
    });
    expect(parsed.accountId).toBe(upper.toLowerCase());
    expect(parsed.detail?.tokenId).toBe(upper.toLowerCase());
    expect(parsed.detail?.category).toBe(upper.toLowerCase());
  });
});
