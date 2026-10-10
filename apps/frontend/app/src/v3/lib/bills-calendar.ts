interface BillsCalendarDay {
  /** `YYYY-MM-DD`. */
  date: string;
  inMonth: boolean;
  isToday: boolean;
  count: number;
  /** Before today with a bill still scheduled on it. */
  overdue: boolean;
}

export interface BillsMonthGrid {
  month: string;
  weeks: BillsCalendarDay[][];
}

const DAY_MS = 86_400_000;

function utcDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM` moved by `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  const [year, monthIndex] = month.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, monthIndex - 1 + delta, 1));
  return isoDay(shifted).slice(0, 7);
}

/**
 * One month of bills as Monday-to-Sunday weeks (SC-1654). Day keys are calendar
 * dates rather than instants, so the arithmetic runs in UTC and no time zone
 * can move a bill onto its neighbour.
 */
export function billsMonthGrid(
  month: string,
  bills: readonly { dueDate: string }[],
  today: string
): BillsMonthGrid {
  const counts = new Map<string, number>();
  for (const bill of bills) counts.set(bill.dueDate, (counts.get(bill.dueDate) ?? 0) + 1);

  const first = utcDate(`${month}-01`);
  const last = utcDate(`${shiftMonth(month, 1)}-01`).getTime() - DAY_MS;
  const leading = (first.getUTCDay() + 6) % 7;
  let cursor = first.getTime() - leading * DAY_MS;

  const weeks: BillsCalendarDay[][] = [];
  while (cursor <= last) {
    const week: BillsCalendarDay[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = isoDay(new Date(cursor));
      const count = counts.get(date) ?? 0;
      week.push({
        date,
        inMonth: date.startsWith(month),
        isToday: date === today,
        count,
        overdue: count > 0 && date < today,
      });
      cursor += DAY_MS;
    }
    weeks.push(week);
  }
  return { month, weeks };
}
