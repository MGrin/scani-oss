const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type RecurrenceIntervalUnit = 'week' | 'month' | 'quarter' | 'year';
export type RecurrenceStatus = 'active' | 'paused' | 'ended';

// The subset of a `payments` row the recurrence engine needs. Deliberately
// narrower than the full `Payment` DB type so this module has no
// dependency on `@scani/db` — it stays a pure function callable from
// anywhere (job processors, forecast queries, tests) without dragging in
// Drizzle or a connection.
export interface RecurrenceSchedule {
  intervalUnit: RecurrenceIntervalUnit;
  intervalCount: number;
  anchorDate: Date;
  status: RecurrenceStatus;
  endDate: Date | null;
  expectedAmount: string | null;
}

export interface PaymentOccurrenceCandidate {
  dueDate: Date;
  expectedAmount: string | null;
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  // Day 0 of the following month is the last day of `monthIndex`; asking
  // Date.UTC for day 0 rolls backward instead of forward, which is what
  // makes this trick work without a lookup table (and without getting
  // February's leap-year rule wrong).
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// Adds a whole number of calendar months to `anchor`, clamping the
// day-of-month to the target month's actual length. This is the crux of
// the "no naive twice-a-month drift" requirement: Jan 31 + 1 month must
// land on Feb 28 (or 29), never overflow into March.
function addUtcMonthsClamped(anchor: Date, monthsToAdd: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const day = anchor.getUTCDate();

  const totalMonths = month + monthsToAdd;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInUtcMonth(targetYear, targetMonth));

  return new Date(Date.UTC(targetYear, targetMonth, clampedDay));
}

function monthsPerOccurrence(intervalUnit: RecurrenceIntervalUnit, intervalCount: number): number {
  switch (intervalUnit) {
    case 'month':
      return intervalCount;
    case 'quarter':
      return intervalCount * 3;
    case 'year':
      return intervalCount * 12;
    case 'week':
      throw new Error('monthsPerOccurrence is not defined for the week interval unit');
  }
}

function occurrenceDate(schedule: RecurrenceSchedule, occurrenceIndex: number): Date {
  if (schedule.intervalUnit === 'week') {
    const stepDays = schedule.intervalCount * 7;
    return new Date(schedule.anchorDate.getTime() + occurrenceIndex * stepDays * MS_PER_DAY);
  }

  const months = monthsPerOccurrence(schedule.intervalUnit, schedule.intervalCount);
  return addUtcMonthsClamped(schedule.anchorDate, occurrenceIndex * months);
}

// Expands a recurring payment definition into dated occurrences within
// [from, to] (inclusive at both ends). Pure and deterministic: no clock
// reads, no DB, no DI — callers (scheduled jobs, forecast queries, tests)
// supply the window explicitly.
export function generateOccurrences(
  schedule: RecurrenceSchedule,
  from: Date,
  to: Date
): PaymentOccurrenceCandidate[] {
  if (schedule.intervalCount <= 0) {
    throw new Error(
      `generateOccurrences: intervalCount must be positive, got ${schedule.intervalCount}`
    );
  }

  if (schedule.status === 'paused') {
    return [];
  }

  const upperBound =
    schedule.endDate !== null && schedule.endDate.getTime() < to.getTime() ? schedule.endDate : to;

  if (upperBound.getTime() < from.getTime()) {
    return [];
  }

  const occurrences: PaymentOccurrenceCandidate[] = [];

  for (let occurrenceIndex = 0; ; occurrenceIndex++) {
    const dueDate = occurrenceDate(schedule, occurrenceIndex);

    if (dueDate.getTime() > upperBound.getTime()) {
      break;
    }

    if (dueDate.getTime() >= from.getTime()) {
      occurrences.push({ dueDate, expectedAmount: schedule.expectedAmount });
    }
  }

  return occurrences;
}
