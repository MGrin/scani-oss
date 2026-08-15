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
 * When real localisation arrives, this constant is the single place that
 * changes — and the call sites, which all omit the argument, need no edit.
 */
export const APP_LOCALE = 'en-GB';

export type DateLocale = string | undefined;

/**
 * "12s ago" / "5m ago" / "3h ago" / "2d ago". For very recent (<45s)
 * returns "just now". For >30 days falls back to an absolute date —
 * after that point absolute dates communicate better than "62d ago".
 */
export function formatRelative(input: DateInput, locale: DateLocale = APP_LOCALE): string {
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
export function formatDateTime(input: DateInput, locale: DateLocale = APP_LOCALE): string {
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
export function formatDate(input: DateInput, locale: DateLocale = APP_LOCALE): string {
  const date = toDate(input);
  if (!date) return '—';
  return date.toLocaleDateString(locale, { dateStyle: 'medium' });
}
