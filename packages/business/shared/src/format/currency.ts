// Currency formatting helpers — single source of truth for "render this
// money value to a user-facing string." Frontend components and email
// templates both call these; hand-rolling `Intl.NumberFormat` per
// component drifts away from a consistent presentation.
//
// Inputs accept `Decimal`-as-string (the canonical balance shape across
// the schema) or `number`. Invalid inputs (NaN / Infinity / unparseable)
// render as the zero-formatted equivalent rather than "NaN" or "—" — UI
// callers want "always shows something reasonable" without sanitizing
// upstream.

export interface FormatCurrencyOptions {
  /** Decimal places (defaults to 2). Use 0 for compact summary displays. */
  decimals?: number;
  /** Override locale (defaults to 'en-US'). */
  locale?: string;
}

/** Rendered in place of a value when the underlying data is null /
 *  undefined — i.e. unpriceable. Standardized so dashboards and lists
 *  agree on the "no price" glyph instead of each picking their own.
 */
export const UNPRICEABLE_PLACEHOLDER = '—';

/**
 * Format a numeric value as currency. Falls back to "<symbol> <number>"
 * when the currency code isn't a known ISO code (Intl rejects custom
 * codes; Scani tokens.symbol can hold anything including private equity
 * tickers).
 *
 * Accepts `null` / `undefined` and returns `UNPRICEABLE_PLACEHOLDER`
 * — this is the canonical "no resolvable price" representation, used
 * by every holding / dashboard / vault display since the silent-zero
 * cleanup. Callers never need to ternary on null before calling.
 */
export function formatCurrency(
  value: number | string | null | undefined,
  currency: string,
  options: FormatCurrencyOptions = {}
): string {
  if (value === null || value === undefined) {
    return UNPRICEABLE_PLACEHOLDER;
  }
  const { decimals = 2, locale = 'en-US' } = options;
  const numeric = typeof value === 'number' ? value : Number(value);
  const safe = Number.isFinite(numeric) ? numeric : 0;

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(safe);
  } catch {
    return `${currency} ${safe.toLocaleString(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`;
  }
}

/**
 * Compact currency formatter for large values (charts, dashboard totals).
 * Below 1,000 falls back to the normal formatter at 0-decimal default
 * since "$0.5K" is silly.
 */
export function formatCompact(
  value: number | string,
  currency: string,
  options: FormatCurrencyOptions = {}
): string {
  const { locale = 'en-US' } = options;
  const numeric = typeof value === 'number' ? value : Number(value);
  const safe = Number.isFinite(numeric) ? numeric : 0;

  if (Math.abs(safe) < 1_000) {
    return formatCurrency(safe, currency, { ...options, decimals: options.decimals ?? 0 });
  }

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(safe);
  } catch {
    return `${currency} ${safe.toLocaleString(locale, { maximumFractionDigits: 1 })}`;
  }
}

/**
 * Plain numeric formatter (no currency symbol). For balance columns
 * where the currency is shown elsewhere on the row.
 */
export function formatNumber(value: number | string, options: FormatCurrencyOptions = {}): string {
  const { decimals, locale = 'en-US' } = options;
  const numeric = typeof value === 'number' ? value : Number(value);
  const safe = Number.isFinite(numeric) ? numeric : 0;
  return safe.toLocaleString(locale, {
    ...(decimals !== undefined
      ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : {}),
  });
}

/**
 * Returns the currency symbol via Intl with a small fallback table for
 * the common ones. Used when the UI wants to render the symbol next to
 * an input box (e.g. "$ ___" prefix on the buy/sell form).
 */
export function getCurrencySymbol(currencyCode: string, locale = 'en-US'): string {
  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    return formatter.format(0).replace(/[\d\s]/g, '');
  } catch {
    const commonSymbols: Record<string, string> = {
      USD: '$',
      EUR: '€',
      GBP: '£',
      JPY: '¥',
    };
    return commonSymbols[currencyCode] || currencyCode;
  }
}

/**
 * Format a byte count as "1.2 MB". Used by the admin dashboard and any
 * UI that surfaces upload sizes / memory metrics.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
