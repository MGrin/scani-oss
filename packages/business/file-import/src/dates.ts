/**
 * Which half of `03/04/2026` is the day.
 *
 * `new Date('03/04/2026')` answers "month" in every JS engine, whatever the
 * bank meant, so it may never decide a numeric date (SC-1291). The order is a
 * property of the whole column: one `25/04` settles every `03/04` beside it.
 */
export type DateOrder = 'day-first' | 'month-first';

/** Set on a parse that stopped because nothing in the file said which order it uses. */
export interface AmbiguousDateOrder {
  rowCount: number;
  /** The first few raw values, as the file spelled them. */
  samples: string[];
}

const NUMERIC_DATE =
  /^(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?:[T\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

const SAMPLE_COUNT = 5;

type Resolved = { order: DateOrder } | { ambiguous: AmbiguousDateOrder } | { order: null };

/**
 * An explicit format wins; then any value the data can only mean one way;
 * then the caller's `fallback` (the source's known order, or the user's
 * answer). With none of those the column is ambiguous, never guessed.
 *
 * A column with values past 12 in BOTH positions fits neither order, so the
 * data cannot settle it and it falls through the same way.
 */
export function resolveDateOrder(
  values: string[],
  format?: string,
  fallback?: DateOrder
): Resolved {
  const fromFormat = orderFromFormat(format);
  if (fromFormat) return { order: fromFormat };

  const numeric = values.filter((v) => NUMERIC_DATE.test(v));
  if (numeric.length === 0) return { order: null };

  let dayFirst = false;
  let monthFirst = false;
  for (const value of numeric) {
    const [, first, , second] = value.match(NUMERIC_DATE)!;
    if (Number(first) > 12) dayFirst = true;
    if (Number(second) > 12) monthFirst = true;
  }
  if (dayFirst !== monthFirst) return { order: dayFirst ? 'day-first' : 'month-first' };
  if (fallback) return { order: fallback };
  return { ambiguous: { rowCount: numeric.length, samples: numeric.slice(0, SAMPLE_COUNT) } };
}

function orderFromFormat(format: string | undefined): DateOrder | null {
  if (!format) return null;
  if (/^d/i.test(format)) return 'day-first';
  if (/^M/.test(format)) return 'month-first';
  return null;
}

/**
 * A numeric day/month date in the given order, as UTC. Anything else — ISO,
 * `1 Apr 2026` — is not ambiguous and goes to `Date` unchanged. A day that
 * does not exist throws rather than rolling into the next month.
 */
export function parseStatementDate(value: string, order: DateOrder | null): Date {
  const match = value.match(NUMERIC_DATE);
  if (!match) {
    const native = new Date(value);
    if (Number.isNaN(native.getTime())) throw new Error(`Cannot parse date: ${value}`);
    return native;
  }
  if (!order) throw new Error(`Cannot tell day from month in date: ${value}`);

  const [, first, , second, rawYear, hh, mm, ss] = match;
  const [day, month] =
    order === 'day-first' ? [Number(first), Number(second)] : [Number(second), Number(first)];
  const year = rawYear!.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  const date = new Date(
    Date.UTC(year, month - 1, day, Number(hh ?? 0), Number(mm ?? 0), Number(ss ?? 0))
  );
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Cannot parse date: ${value}`);
  }
  return date;
}
