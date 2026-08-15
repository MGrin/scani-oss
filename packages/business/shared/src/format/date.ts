// Date formatting helpers. Lightweight on purpose — pulling in date-fns
// just for "X ago" doubles the frontend bundle. If a more sophisticated
// need arises (i18n relative-time, business-day math, timezone juggling)
// upgrade to Intl.RelativeTimeFormat or import a real lib.

export type DateInput = string | number | Date | null | undefined;

function toDate(input: DateInput): Date | null {
  if (input === null || input === undefined) return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * The reader's own locale, always.
 *
 * These four helpers used to default `locale` to `'en-US'`, and every one of
 * the ~20 call sites in the app omitted the argument — so a European reader
 * was shown `7/16/2026` while anything that reached for a bare
 * `toLocaleDateString()` on the same screen printed `16/07/2026`. Two orders,
 * one date, no way to tell which was which: `7/5/2026` is either 5 July or
 * 7 May depending on which line of the sheet you read it on (SC-175).
 *
 * `undefined` is not "no locale" — it is the runtime's, which in a browser is
 * the reader's. Callers may still pass one explicitly; nothing in the app
 * needs to.
 */
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
  return date.toLocaleString(locale, {
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
  return date.toLocaleDateString(locale, { dateStyle: 'medium' });
}
