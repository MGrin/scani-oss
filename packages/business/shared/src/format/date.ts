// Date formatting helpers. Lightweight on purpose — pulling in date-fns
// just for "X ago" doubles the frontend bundle. If a more sophisticated
// need arises (i18n relative-time, business-day math, timezone juggling)
// upgrade to Intl.RelativeTimeFormat or import a real lib.

import { getFormatLocale } from './locale';

export type DateInput = string | number | Date | null | undefined;

function toDate(input: DateInput): Date | null {
  if (input === null || input === undefined) return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * One locale, everywhere: `en-GB`.
 *
 * SC-175 found a real defect — these helpers defaulted to `'en-US'` while
 * anything reaching for a bare `toLocaleDateString()` used the runtime's, so
 * one screen showed `7/16/2026` and `16/07/2026` at once. `7/5/2026` is
 * either 5 July or 7 May depending on which line you read it on.
 *
 * The first fix dropped the default so everything followed the reader's
 * locale. That produced a worse failure: **the app has no i18n and every
 * string in it is English**, so a reader whose device is set to Russian saw
 * `14 авг. 2026 г., 16:43` sitting under an English heading, in an English
 * sheet, beside English buttons. Reported from production the same day.
 *
 * Following the reader's locale is only coherent once the interface follows
 * it too. Until then the honest answer is that this is an English product,
 * so it shows English dates.
 *
 * `en-GB` rather than `en-US` for two reasons: it renders `16 Jul 2026`,
 * which is month-named and therefore unambiguous in a way no numeric order
 * can be; and `apps/backend/api/src/lib/pdf/layout.ts` already pins `en-GB`
 * with `timeZone: 'UTC'`, so a statement and the screen it was exported from
 * now agree.
 *
 * **That arrival is SC-201, and it has happened.** The pin is no longer the
 * value the helpers read — `./locale.ts` resolves one from the interface
 * language and the reader's optional region, and this constant is what that
 * resolution returns for English with no region chosen. It stays exported and
 * stays `'en-GB'` because two callers legitimately want the English tag rather
 * than the reader's: `apps/backend/api/src/lib/pdf/layout.ts`, which renders a
 * statement server-side where there is no reader, and the tests that pin what
 * English renders. A test asserts it still equals what the table resolves, so
 * the two cannot drift.
 */
export const APP_LOCALE = 'en-GB';

/** The locale a call site gets when it omits the argument, as it should. */
function defaultDateLocale(): string {
  return getFormatLocale().dateLocale;
}

export type DateLocale = string | undefined;

/**
 * "12s ago" / "5m ago" / "3h ago" / "2d ago". For very recent (<45s)
 * returns "just now". For >30 days falls back to an absolute date —
 * after that point absolute dates communicate better than "62d ago".
 */
export function formatRelative(input: DateInput, locale?: DateLocale): string {
  const date = toDate(input);
  if (!date) return '—';
  const diffMs = Date.now() - date.getTime();
  const seconds = Math.round(diffMs / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return `${days}d ago`;
  // `formatDate`, not a numeric `toLocaleDateString`. The numeric short form
  // is the ambiguous one — and this fallback is invisible until history ages
  // past 30 days, so the day it appears is the day a list that read "3d ago"
  // starts printing dates that disagree with the sheet it opens (SC-175).
  return formatDate(date, locale);
}

/**
 * Format as ISO YYYY-MM-DD (UTC). Used for chart axis labels and
 * `portfolio_value_daily.snapshot_date` lookups.
 */
export function formatIsoDate(input: DateInput): string {
  const date = toDate(input);
  if (!date) return '—';
  return date.toISOString().slice(0, 10);
}

/**
 * Locale-formatted date+time string. Sensible default for "last
 * synced at" / "transaction occurred at" displays.
 */
export function formatDateTime(input: DateInput, locale?: DateLocale): string {
  const date = toDate(input);
  if (!date) return '—';
  return date.toLocaleString(locale ?? defaultDateLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Locale-formatted date-only string ("Jan 5, 2026" / "5 Jan 2026"). For row
 * metadata where the time of day doesn't add information.
 *
 * Medium, never the numeric short form. In the English locales this UI ships
 * in that means a named month, which is the one form `7/5/2026` cannot be
 * misread as — it is 5 July in en-GB and 7 May in en-US and the queue shows
 * both readers the same string. (Not universal: de-DE's medium style is still
 * `15.01.2020`. There the win is only consistency, which is the larger half of
 * SC-175 anyway.) It is also what `formatDateTime` and the chart axis already
 * print, so one screen can show a date twice without showing it two ways.
 */
export function formatDate(input: DateInput, locale?: DateLocale): string {
  const date = toDate(input);
  if (!date) return '—';
  return date.toLocaleDateString(locale ?? defaultDateLocale(), { dateStyle: 'medium' });
}

/**
 * The name of a weekday, from `Intl` (SC-300).
 *
 * `dayOfWeek` is 0 = Sunday … 6 = Saturday, matching `payment_schedules.day_of_week`.
 *
 * **This lives here rather than at the call site on purpose.** It replaced a
 * hand-rolled `DAY_NAMES` array in `v3/lib/holdings.ts`, and the failure that
 * array represents is not that it was English — the app is English today and
 * `APP_LOCALE` is pinned to `en-GB` deliberately. It is that the name could
 * never follow the locale when that pin lifts, and that the alternative fix —
 * seven day names and twelve month names in the string catalogue — is 56
 * entries to maintain in every language for something every runtime already
 * knows.
 *
 * Putting it in `date.ts` is the point: this file owns `APP_LOCALE` and every
 * other date rendering, and a second module that formats dates is exactly how
 * the "always go through the helpers" rule was broken in the first place
 * (SC-175, then this).
 *
 * The reference date is a real Sunday — 2024-01-07 — advanced by `dayOfWeek`,
 * and formatted with `timeZone: 'UTC'`. The timezone is load-bearing, not
 * decoration: without it a runtime west of UTC renders midnight UTC as the
 * previous evening, and every name comes out one day early.
 *
 * Returns `'—'` for anything outside 0-6, matching how the rest of this file
 * answers an input it cannot render.
 */
export function weekdayName(dayOfWeek: number, locale?: DateLocale): string {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return '—';
  // 2024-01-07 is a Sunday, so + dayOfWeek lands on the day asked for.
  const reference = new Date(Date.UTC(2024, 0, 7 + dayOfWeek));
  return reference.toLocaleDateString(locale ?? defaultDateLocale(), {
    weekday: 'long',
    timeZone: 'UTC',
  });
}

/**
 * The name of a month, from `Intl` (SC-300).
 *
 * `month` is 1 = January … 12 = December, matching `payment_schedules.month`
 * — one-based, unlike `Date`'s own zero-based months, which is why the array
 * this replaces carried an empty string at index 0.
 *
 * Same reasoning as `weekdayName`: `timeZone: 'UTC'` and a mid-month reference
 * day so no offset can push the result into an adjacent month.
 */
export function monthName(month: number, locale?: DateLocale): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) return '—';
  const reference = new Date(Date.UTC(2024, month - 1, 15));
  return reference.toLocaleDateString(locale ?? defaultDateLocale(), {
    month: 'long',
    timeZone: 'UTC',
  });
}

/**
 * A day and a month together — "15 February", «15 февраля», "February 15"
 * (SC-413).
 *
 * **This exists because a month name alone is the wrong word in most of the
 * world's languages.** `monthName` asks `Intl` for `{ month: 'long' }` and
 * gets the *stand-alone* form, which is what a picker needs and what a date
 * does not: Russian dates take the genitive, so a template reading
 * `«{{day}} {{month}}»` over `monthName(2)` renders «15 февраль» where the
 * sentence needs «15 февраля». Polish and Czech do the same thing; German and
 * French do not, which is why it survived review in an English product.
 *
 * The word order is `Intl`'s too, and that is the second half of the fix. A
 * template that concatenates a day and a month has already decided the order,
 * and it is wrong for half the readers it reaches — this renders `15 February`
 * for en-GB and `February 15` for en-US off the same string.
 *
 * `month` is one-based, as everywhere else in this file. The reference year is
 * a leap year so that 29 February is a date rather than a roll-over into
 * March; a `day` the month does not have returns `'—'` rather than the day it
 * would spill onto.
 */
export function formatDayMonth(day: number, month: number, locale?: DateLocale): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) return '—';
  if (!Number.isInteger(day) || day < 1) return '—';
  // Day 0 of the following month is the last day of this one.
  if (day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return '—';
  return new Date(Date.UTC(2024, month - 1, day)).toLocaleDateString(
    locale ?? defaultDateLocale(),
    { day: 'numeric', month: 'long', timeZone: 'UTC' }
  );
}

/**
 * The month as it appears *inside a date* — «февраля», not «февраль» (SC-413).
 *
 * Same distinction as `formatDayMonth`, for the sentences that name a month
 * without a day: "the last day of February", «в последний день февраля». The
 * form is read back out of a formatted day-and-month with `formatToParts`,
 * because `Intl` exposes the two contexts only through what it is asked to
 * format — there is no option that says "genitive".
 *
 * `monthName` remains the right call for a list of months and for a month that
 * starts a sentence; this one is only for a month standing in a phrase.
 */
export function monthNameInDate(month: number, locale?: DateLocale): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) return '—';
  const parts = new Intl.DateTimeFormat(locale ?? defaultDateLocale(), {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).formatToParts(new Date(Date.UTC(2024, month - 1, 15)));
  return parts.find((part) => part.type === 'month')?.value ?? monthName(month, locale);
}
