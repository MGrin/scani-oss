import Decimal from 'decimal.js';

/**
 * The reminder mgrin asked for (SC-226):
 *
 * > "if I have 5 payments tomorrow that totals to 500$ I need to receive a
 * >  notification on my phone (PWA) today at around 5PM my local time"
 *
 * Four requirements live in that sentence, and this file is where three of
 * them are decided. The fourth — that it arrives on an installed PWA — is the
 * client's problem.
 *
 * 1. ONE notification, aggregated. Five pushes for five bills is a different
 *    and worse product: the value is the glance that tells you whether to
 *    move money tonight, and five notifications is a task list.
 * 2. TOMORROW, in the user's own local day — not `now + 24h`.
 * 3. ~17:00 LOCAL, which is why the job runs hourly and selects, rather than
 *    running once at a fixed UTC hour.
 */

/** The local hour the reminder targets. "around 5PM" (SC-226). */
export const REMINDER_LOCAL_HOUR = 17;

export interface ReminderCandidate {
  userId: string;
  /** IANA zone, or null when the browser has not reported one yet. */
  timezone: string | null;
}

export interface DueOccurrence {
  occurrenceId: string;
  /** `YYYY-MM-DD`, the stored `payment_occurrences.due_date`. */
  dueDate: string;
  /** Decimal string; null for a variable payment with no estimate. */
  expectedAmount: string | null;
  currencyTokenId: string;
  currencySymbol: string;
}

export interface ReminderSummary {
  /** Every occurrence due, including ones with no amount. */
  count: number;
  /**
   * Total per currency, keyed by symbol. A map rather than one number
   * because a total is only meaningful within a currency, and converting
   * here would need a rate this job has no business fetching.
   */
  totals: Map<string, Decimal>;
  /** Occurrences whose amount is unknown — counted, never summed. */
  unknownAmountCount: number;
}

/**
 * The user's local calendar date, `YYYY-MM-DD`, at instant `now`.
 *
 * `en-CA` is not a locale choice, it is the shortest way to get ISO order out
 * of `Intl` — and `Intl` is what knows that Asia/Makassar is +08 while
 * Europe/London is +01 in August. Doing this with an offset number instead
 * would be wrong twice a year in every zone that observes DST.
 */
export function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The user's local hour, 0-23, at instant `now`. */
export function localHour(now: Date, timezone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  }).format(now);
  // `en-GB` renders midnight as `24` in some ICU versions; normalise so the
  // caller never sees an hour that does not exist.
  return Number.parseInt(hour, 10) % 24;
}

/** The local calendar day AFTER the user's today. */
export function localTomorrow(now: Date, timezone: string): string {
  const today = localDate(now, timezone);
  const [y, m, d] = today.split('-').map(Number);
  // Constructed as UTC purely as calendar arithmetic — this is a date, not an
  // instant, so no zone is involved once we already have the local Y/M/D.
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Whether this user should be reminded on this hourly fire.
 *
 * **A null timezone is skipped, not defaulted.** Defaulting to UTC looks
 * harmless and is the bug: for a user in Singapore "17:00 UTC" is 01:00, so
 * the default converts the feature into a middle-of-the-night alarm. No
 * reminder is visibly nothing; a reminder at 01:00 is invisibly wrong, and
 * the user cannot tell which of the two they are experiencing.
 *
 * An unrecognised zone is skipped for the same reason — `Intl` throws on
 * garbage, and a stored value we cannot interpret is not better than none.
 */
export function shouldRemindNow(now: Date, candidate: ReminderCandidate): boolean {
  if (!candidate.timezone) return false;
  try {
    return localHour(now, candidate.timezone) === REMINDER_LOCAL_HOUR;
  } catch {
    return false;
  }
}

/**
 * Aggregate one user's occurrences due on their local tomorrow.
 *
 * Occurrences are matched on the stored `due_date` string, which is a
 * calendar date with no zone of its own — so comparing it to the user's local
 * tomorrow is the correct comparison, and converting either side to an
 * instant would introduce a zone that is not in the data.
 */
export function summariseForTomorrow(
  now: Date,
  timezone: string,
  occurrences: readonly DueOccurrence[]
): ReminderSummary {
  const tomorrow = localTomorrow(now, timezone);
  const due = occurrences.filter((o) => o.dueDate === tomorrow);

  const totals = new Map<string, Decimal>();
  let unknownAmountCount = 0;
  for (const o of due) {
    if (o.expectedAmount === null) {
      unknownAmountCount += 1;
      continue;
    }
    const current = totals.get(o.currencySymbol) ?? new Decimal(0);
    totals.set(o.currencySymbol, current.add(new Decimal(o.expectedAmount)));
  }
  return { count: due.length, totals, unknownAmountCount };
}

/**
 * The notification body.
 *
 * Deliberately not localised. Every other user-facing string went through
 * `t()` in SC-202, and this one cannot: it is composed on the worker, which
 * has no i18n bundle and no request to read a language from. Rather than
 * pretend otherwise with a half-translated string, it is English and the
 * ticket to translate it is a real one — the alternative is a `t()` call on
 * the server that silently returns its own key.
 */
export function reminderBody(summary: ReminderSummary): string {
  const bills = summary.count === 1 ? '1 payment' : `${summary.count} payments`;
  const parts = [...summary.totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, total]) => `${symbol}${total.toFixed(2)}`);

  if (parts.length === 0) {
    // Everything due is a variable payment with no estimate. Saying "0.00"
    // would be a number nobody entered.
    return `${bills} due tomorrow`;
  }
  const amounts = parts.join(' + ');
  // A count that includes unknown-amount rows alongside a total that cannot
  // include them would read as if the total covered all of them.
  const caveat =
    summary.unknownAmountCount > 0 ? ` (${summary.unknownAmountCount} with no amount set)` : '';
  return `${bills} due tomorrow · ${amounts}${caveat}`;
}
