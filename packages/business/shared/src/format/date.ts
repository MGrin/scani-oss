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
 * "12s ago" / "5m ago" / "3h ago" / "2d ago". For very recent (<45s)
 * returns "just now". For >30 days falls back to a locale date string —
 * after that point absolute dates communicate better than "62d ago".
 */
export function formatRelative(input: DateInput, locale = 'en-US'): string {
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
  return date.toLocaleDateString(locale);
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
export function formatDateTime(input: DateInput, locale = 'en-US'): string {
  const date = toDate(input);
  if (!date) return '—';
  return date.toLocaleString(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Locale-formatted date-only string ("Jan 5, 2026"). For row metadata
 * where the time of day doesn't add information.
 */
export function formatDate(input: DateInput, locale = 'en-US'): string {
  const date = toDate(input);
  if (!date) return '—';
  return date.toLocaleDateString(locale, { dateStyle: 'medium' });
}
