import { describe, expect, test } from 'bun:test';
import {
  generateOccurrences,
  type RecurrenceSchedule,
} from '../../../src/services/payments/recurrence';

// generateOccurrences is the highest-risk logic in the payments feature:
// every forecast, calendar row, and "did I pay this" reconciliation is
// derived from it. It is a pure function of (payment, from, to) — no
// Date.now(), no DB, no DI — so these tests are deterministic and can't
// rot with the calendar.

function schedule(overrides: Partial<RecurrenceSchedule> = {}): RecurrenceSchedule {
  return {
    intervalUnit: 'month',
    intervalCount: 1,
    anchorDate: new Date('2026-01-01'),
    status: 'active',
    endDate: null,
    expectedAmount: null,
    ...overrides,
  };
}

describe('generateOccurrences', () => {
  test('fortnightly from a Friday yields 26 Fridays in a year', () => {
    // mgrin is paid every other Friday — this is the real-world case
    // that motivated the brief. A naive "twice a month" implementation
    // gives 24 and drifts off Friday; this must not.
    const out = generateOccurrences(
      schedule({ intervalUnit: 'week', intervalCount: 2, anchorDate: new Date('2026-01-02') }),
      new Date('2026-01-01'),
      new Date('2026-12-31')
    );

    expect(out).toHaveLength(26);
    expect(out.every((o) => o.dueDate.getUTCDay() === 5)).toBe(true);
  });

  test('month-end anchors clamp rather than overflowing', () => {
    const out = generateOccurrences(
      schedule({ intervalUnit: 'month', intervalCount: 1, anchorDate: new Date('2026-01-31') }),
      new Date('2026-01-01'),
      new Date('2026-04-30')
    );

    expect(out.map((o) => o.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  test('leap February clamps to the 29th', () => {
    const out = generateOccurrences(
      schedule({ intervalUnit: 'month', intervalCount: 1, anchorDate: new Date('2028-01-31') }),
      new Date('2028-01-01'),
      new Date('2028-03-31')
    );

    expect(out.map((o) => o.dueDate.toISOString().slice(0, 10))).toEqual([
      '2028-01-31',
      '2028-02-29',
      '2028-03-31',
    ]);
  });

  test('quarterly intervals step every 3 months', () => {
    const out = generateOccurrences(
      schedule({ intervalUnit: 'quarter', intervalCount: 1, anchorDate: new Date('2026-01-15') }),
      new Date('2026-01-01'),
      new Date('2026-12-31')
    );

    expect(out.map((o) => o.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-01-15',
      '2026-04-15',
      '2026-07-15',
      '2026-10-15',
    ]);
  });

  test('a quarterly interval count of 2 steps every 6 months (semiannual)', () => {
    const out = generateOccurrences(
      schedule({ intervalUnit: 'quarter', intervalCount: 2, anchorDate: new Date('2026-01-31') }),
      new Date('2026-01-01'),
      new Date('2027-12-31')
    );

    expect(out.map((o) => o.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-07-31',
      '2027-01-31',
      '2027-07-31',
    ]);
  });

  test('annual intervals step every 12 months, including across a leap year', () => {
    const out = generateOccurrences(
      schedule({ intervalUnit: 'year', intervalCount: 1, anchorDate: new Date('2027-02-28') }),
      new Date('2027-01-01'),
      new Date('2029-12-31')
    );

    // Anchored on a non-leap Feb 28th, the day-of-month never needs
    // clamping — it should NOT drift to the 29th just because 2028 is
    // a leap year.
    expect(out.map((o) => o.dueDate.toISOString().slice(0, 10))).toEqual([
      '2027-02-28',
      '2028-02-28',
      '2029-02-28',
    ]);
  });

  test('an annual interval count of 2 steps every 24 months (biennial)', () => {
    const out = generateOccurrences(
      schedule({ intervalUnit: 'year', intervalCount: 2, anchorDate: new Date('2026-06-01') }),
      new Date('2026-01-01'),
      new Date('2030-12-31')
    );

    expect(out.map((o) => o.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-06-01',
      '2028-06-01',
      '2030-06-01',
    ]);
  });

  test('an ended payment stops at end_date', () => {
    const out = generateOccurrences(
      schedule({
        intervalUnit: 'month',
        intervalCount: 1,
        anchorDate: new Date('2026-01-01'),
        status: 'ended',
        endDate: new Date('2026-03-01'),
      }),
      new Date('2026-01-01'),
      new Date('2026-12-31')
    );

    // Would have run through December were it not for end_date — the
    // window's `to` is intentionally far past the end to prove end_date
    // is doing the clamping, not the window.
    expect(out.map((o) => o.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  test('a paused payment generates nothing', () => {
    const out = generateOccurrences(
      schedule({ status: 'paused', anchorDate: new Date('2026-01-01') }),
      new Date('2026-01-01'),
      new Date('2026-12-31')
    );

    expect(out).toEqual([]);
  });

  test('occurrences before `from` are excluded even when the anchor predates it', () => {
    const out = generateOccurrences(
      schedule({ intervalUnit: 'month', intervalCount: 1, anchorDate: new Date('2025-11-15') }),
      new Date('2026-01-01'),
      new Date('2026-02-28')
    );

    expect(out.map((o) => o.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-01-15',
      '2026-02-15',
    ]);
  });

  test('a due date exactly on `from` or `to` is inclusive at both boundaries', () => {
    const out = generateOccurrences(
      schedule({ intervalUnit: 'month', intervalCount: 1, anchorDate: new Date('2026-01-01') }),
      new Date('2026-01-01'),
      new Date('2026-03-01')
    );

    expect(out.map((o) => o.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  test('expectedAmount is carried onto every generated occurrence', () => {
    const out = generateOccurrences(
      schedule({
        intervalUnit: 'month',
        intervalCount: 1,
        anchorDate: new Date('2026-01-01'),
        expectedAmount: '1234.56',
      }),
      new Date('2026-01-01'),
      new Date('2026-02-28')
    );

    expect(out.every((o) => o.expectedAmount === '1234.56')).toBe(true);
  });

  test('a variable payment with no expected amount yields null on every occurrence', () => {
    const out = generateOccurrences(
      schedule({
        intervalUnit: 'month',
        intervalCount: 1,
        anchorDate: new Date('2026-01-01'),
        expectedAmount: null,
      }),
      new Date('2026-01-01'),
      new Date('2026-02-28')
    );

    expect(out.every((o) => o.expectedAmount === null)).toBe(true);
  });

  test('an empty window (to before from) yields no occurrences', () => {
    const out = generateOccurrences(
      schedule({ anchorDate: new Date('2026-01-01') }),
      new Date('2026-06-01'),
      new Date('2026-01-01')
    );

    expect(out).toEqual([]);
  });

  test('rejects a non-positive interval count rather than looping forever', () => {
    expect(() =>
      generateOccurrences(
        schedule({ intervalCount: 0, anchorDate: new Date('2026-01-01') }),
        new Date('2026-01-01'),
        new Date('2026-02-01')
      )
    ).toThrow();
  });
});
