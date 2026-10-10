import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { billsMonthGrid, shiftMonth } from '../../../src/v3/lib/bills-calendar';

const bill = (dueDate: string) => ({ dueDate });

describe('billsMonthGrid (SC-1654)', () => {
  // October 2026 starts on a Thursday and ends on a Saturday.
  const grid = billsMonthGrid(
    '2026-10',
    [bill('2026-10-05'), bill('2026-10-05'), bill('2026-10-20'), bill('2026-11-02')],
    '2026-10-11'
  );

  test('weeks run Monday to Sunday and cover the whole month', () => {
    expect(grid.weeks.every((week) => week.length === 7)).toBe(true);
    expect(grid.weeks[0]?.[0]?.date).toBe('2026-09-28');
    expect(grid.weeks.at(-1)?.at(-1)?.date).toBe('2026-11-01');
    expect(grid.weeks).toHaveLength(5);
  });

  test('each day counts its bills, and days outside the month are marked', () => {
    const days = grid.weeks.flat();
    const byDate = new Map(days.map((day) => [day.date, day]));
    expect(byDate.get('2026-10-05')?.count).toBe(2);
    expect(byDate.get('2026-10-20')?.count).toBe(1);
    expect(byDate.get('2026-10-06')?.count).toBe(0);
    expect(byDate.get('2026-09-28')?.inMonth).toBe(false);
    expect(byDate.get('2026-10-01')?.inMonth).toBe(true);
  });

  test('today is marked, and a past day with bills is overdue', () => {
    const byDate = new Map(grid.weeks.flat().map((day) => [day.date, day]));
    expect(byDate.get('2026-10-11')?.isToday).toBe(true);
    expect(byDate.get('2026-10-05')?.overdue).toBe(true);
    expect(byDate.get('2026-10-20')?.overdue).toBe(false);
  });

  test('a month that starts on Monday has no leading days from the month before', () => {
    // June 2026 starts on a Monday.
    expect(billsMonthGrid('2026-06', [], '2026-10-11').weeks[0]?.[0]?.date).toBe('2026-06-01');
  });
});

describe('shiftMonth', () => {
  test('moves across year boundaries', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-10', 0)).toBe('2026-10');
  });
});
