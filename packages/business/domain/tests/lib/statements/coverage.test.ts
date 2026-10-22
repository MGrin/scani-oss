import { describe, expect, test } from 'bun:test';
import { statementGaps } from '../../../src/lib/statements/coverage';

// SC-1656: a gap is a calendar month, from the account's first statement up to
// `through`, that no statement covers. Activity cannot define it: a missing
// statement on an account fed only by statements leaves that month with no
// activity at all.

describe('statementGaps', () => {
  test('a month between two statements that neither covers is a gap', () => {
    expect(
      statementGaps({
        statements: [
          { from: '2026-01-01', to: '2026-01-31' },
          { from: '2026-03-01', to: '2026-03-31' },
        ],
        through: '2026-03',
      })
    ).toEqual(['2026-02']);
  });

  test('months after the last statement, up to `through`, are gaps', () => {
    expect(
      statementGaps({ statements: [{ from: '2026-01-01', to: '2026-01-31' }], through: '2026-03' })
    ).toEqual(['2026-02', '2026-03']);
  });

  test('a statement that touches any day of a month covers it', () => {
    expect(
      statementGaps({ statements: [{ from: '2026-01-25', to: '2026-02-03' }], through: '2026-02' })
    ).toEqual([]);
  });

  test('a statement spanning several months covers each of them, across a year end', () => {
    expect(
      statementGaps({ statements: [{ from: '2025-11-10', to: '2026-02-28' }], through: '2026-02' })
    ).toEqual([]);
  });

  test('nothing before the first statement is a gap, and no statement means no gaps', () => {
    expect(
      statementGaps({ statements: [{ from: '2026-05-01', to: '2026-05-31' }], through: '2026-05' })
    ).toEqual([]);
    expect(statementGaps({ statements: [], through: '2026-05' })).toEqual([]);
  });

  test('a statement reaching past `through` adds no gap after it', () => {
    expect(
      statementGaps({ statements: [{ from: '2026-04-01', to: '2026-06-30' }], through: '2026-05' })
    ).toEqual([]);
  });
});
