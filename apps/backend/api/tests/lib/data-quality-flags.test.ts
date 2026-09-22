import { describe, expect, test } from 'bun:test';
import { lacksCoverage } from '../../src/lib/data-quality-flags';

describe('lacksCoverage (SC-1252)', () => {
  test('a hand-typed holding, with no transactions, is not flagged', () => {
    expect(lacksCoverage({ has_transactions: false, has_coverage: false })).toBe(false);
  });

  test('a ledger with no coverage row beside it is flagged', () => {
    expect(lacksCoverage({ has_transactions: true, has_coverage: false })).toBe(true);
  });

  test('a covered ledger is not', () => {
    expect(lacksCoverage({ has_transactions: true, has_coverage: true })).toBe(false);
  });
});
