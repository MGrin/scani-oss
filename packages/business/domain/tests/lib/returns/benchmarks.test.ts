import { describe, expect, test } from 'bun:test';
import { benchmarkDaysToFetch } from '../../../src/lib/returns/benchmarks';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (days: Date[]) => days.map((x) => x.toISOString().slice(0, 10));

describe('benchmarkDaysToFetch (SC-464)', () => {
  test('nothing stored: every day from the earliest portfolio day through yesterday', () => {
    expect(
      iso(
        benchmarkDaysToFetch({
          earliestNeeded: d('2026-01-01'),
          storedFirst: null,
          storedLast: null,
          through: d('2026-01-03'),
        })
      )
    ).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  test('only the edges outside what is stored, never the gaps inside it', () => {
    expect(
      iso(
        benchmarkDaysToFetch({
          earliestNeeded: d('2026-01-01'),
          storedFirst: d('2026-01-03'),
          storedLast: d('2026-01-05'),
          through: d('2026-01-07'),
        })
      )
    ).toEqual(['2026-01-01', '2026-01-02', '2026-01-06', '2026-01-07']);
  });

  test('fully covered is nothing to fetch', () => {
    expect(
      benchmarkDaysToFetch({
        earliestNeeded: d('2026-01-02'),
        storedFirst: d('2026-01-01'),
        storedLast: d('2026-01-07'),
        through: d('2026-01-07'),
      })
    ).toEqual([]);
  });

  test('no portfolio has been measured yet: nothing to compare, nothing to fetch', () => {
    expect(
      benchmarkDaysToFetch({
        earliestNeeded: null,
        storedFirst: null,
        storedLast: null,
        through: d('2026-01-07'),
      })
    ).toEqual([]);
  });
});
