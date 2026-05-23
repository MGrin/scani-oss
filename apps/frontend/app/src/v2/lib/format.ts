export interface FormatMoneyOptions {
  /** Decimal places (defaults to 2). Use 0 for compact summary displays. */
  decimals?: number;
  /** Override locale (defaults to en-US). */
  locale?: string;
}

/**
 * Format a numeric value as currency using Intl.NumberFormat.
 * Accepts a string (Decimal-as-string) or number; invalid inputs render as
 * the zero-formatted equivalent rather than "NaN" — so callers don't have
 * to sanitize beforehand.
 */
export function formatMoney(
  value: number | string,
  currency: string,
  options: FormatMoneyOptions = {}
): string {
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
    // Non-ISO currency codes (rare, but tokens.symbol can hold anything).
    // Fall back to "<symbol> <formatted>" so the UI still shows *something*
    // reasonable instead of exploding.
    return `${currency} ${safe.toLocaleString(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`;
  }
}

/**
 * Compact currency formatter for large values (e.g. charts, totals).
 * Below 1,000 falls back to the normal 0-decimal form.
 */
export function formatCompact(
  value: number | string,
  currency: string,
  options: FormatMoneyOptions = {}
): string {
  const { locale = 'en-US' } = options;
  const numeric = typeof value === 'number' ? value : Number(value);
  const safe = Number.isFinite(numeric) ? numeric : 0;

  if (Math.abs(safe) < 1_000) {
    return formatMoney(safe, currency, { ...options, decimals: options.decimals ?? 0 });
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
