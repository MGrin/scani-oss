import type { TaxYearStart } from '@scani/shared';

const START: Record<TaxYearStart, { month: number; day: number }> = {
  'jan-1': { month: 0, day: 1 },
  'apr-1': { month: 3, day: 1 },
  'apr-6': { month: 3, day: 6 },
  'jul-1': { month: 6, day: 1 },
};

/** Milliseconds `timeZone` is ahead of UTC at `at`. */
function offsetAt(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return local - Math.floor(at / 1000) * 1000;
}

/** The instant local midnight begins on a date in `timeZone`. */
function localMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month, day);
  // Read the offset twice: the first guess can sit on the other side of a DST
  // change from the answer, and the second read is taken at the answer itself.
  const guess = wall - offsetAt(wall, timeZone);
  return new Date(wall - offsetAt(guess, timeZone));
}

/**
 * The half-open window `[from, to)` of tax year `year` — the one starting in
 * that calendar year — read in `timeZone`.
 *
 * Half-open so adjacent years partition time: a disposal at the boundary
 * instant belongs to the later year and to one year only.
 */
export function taxYearWindow(
  year: number,
  start: TaxYearStart,
  timeZone: string
): { from: Date; to: Date } {
  if (!isKnownZone(timeZone)) throw new RangeError(`Unknown time zone: ${timeZone}`);
  const { month, day } = START[start];
  return {
    from: localMidnight(year, month, day, timeZone),
    to: localMidnight(year + 1, month, day, timeZone),
  };
}

function isKnownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone a user's tax-year boundaries are read in: their stored one, or UTC
 * named as a fallback when none is stored or this runtime does not know it.
 */
export function taxYearZone(stored: string | null): {
  timeZone: string;
  source: 'user' | 'utc-fallback';
} {
  return stored && isKnownZone(stored)
    ? { timeZone: stored, source: 'user' }
    : { timeZone: 'UTC', source: 'utc-fallback' };
}
