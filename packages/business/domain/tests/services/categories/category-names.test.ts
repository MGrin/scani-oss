import { describe, expect, test } from 'bun:test';
import {
  CategoryNameError,
  normalizeCategoryName,
  parseImportedCategory,
} from '../../../src/services/categories/category-names';

describe('normalizeCategoryName (SC-1652)', () => {
  test('trims and collapses inner whitespace', () => {
    expect(normalizeCategoryName(' Food  &  Drink ')).toBe('Food & Drink');
  });

  test('refuses an empty name and one over 60 characters', () => {
    expect(() => normalizeCategoryName('   ')).toThrow(CategoryNameError);
    expect(() => normalizeCategoryName('x'.repeat(61))).toThrow(CategoryNameError);
    expect(normalizeCategoryName('x'.repeat(60))).toHaveLength(60);
  });
});

describe('parseImportedCategory (SC-1652)', () => {
  test('splits a group and a name on the first ": "', () => {
    expect(parseImportedCategory('Bills: Rent')).toEqual({ parent: 'Bills', child: 'Rent' });
    expect(parseImportedCategory('A: B: C')).toEqual({ parent: 'A', child: 'B: C' });
  });

  test('a flat name is a top-level category', () => {
    expect(parseImportedCategory('Groceries')).toEqual({ parent: 'Groceries', child: null });
  });

  test("YNAB's own bookkeeping categories and empty input are no category", () => {
    expect(parseImportedCategory('Inflow: Ready to Assign')).toBeNull();
    expect(parseImportedCategory('Inflow: To be Budgeted')).toBeNull();
    expect(parseImportedCategory('Internal Master Category: Uncategorized')).toBeNull();
    expect(parseImportedCategory('  ')).toBeNull();
    expect(parseImportedCategory(null)).toBeNull();
  });
});
