import { describe, expect, test } from 'bun:test';
import {
  APP_NUMBER_LOCALE,
  formatBytes,
  formatCompact,
  formatCurrency,
  formatNumber,
  getCurrencySymbol,
} from '../../src/format/currency';
import { APP_LOCALE } from '../../src/format/date';

describe('APP_NUMBER_LOCALE', () => {
  test('is what every helper here defaults to, so a call site can omit it', () => {
    expect(formatCurrency(1234.5, 'USD')).toBe(
      formatCurrency(1234.5, 'USD', { locale: APP_NUMBER_LOCALE })
    );
    expect(formatCompact(12_345, 'USD')).toBe(
      formatCompact(12_345, 'USD', { locale: APP_NUMBER_LOCALE })
    );
    expect(formatNumber(1234.5)).toBe(formatNumber(1234.5, { locale: APP_NUMBER_LOCALE }));
    expect(getCurrencySymbol('USD')).toBe(getCurrencySymbol('USD', APP_NUMBER_LOCALE));
  });

  test('differs from APP_LOCALE only where the two locales disagree', () => {
    // Not an oversight (SC-184): en-GB and en-US group and separate digits
    // identically, so numbers lose nothing by not following the date constant
    // — and en-GB writes the dollar `US$`, which the product has never shown.
    expect(APP_LOCALE).toBe('en-GB');
    expect(formatNumber(4_200_000, { locale: APP_LOCALE })).toBe(formatNumber(4_200_000));
    expect(formatCurrency(1234.5, 'USD', { locale: APP_LOCALE })).toBe('US$1,234.50');
    expect(formatCurrency(1234.5, 'USD')).toBe('$1,234.50');
  });
});

describe('formatCurrency', () => {
  test('formats USD with default 2 decimals', () => {
    expect(formatCurrency(1234.5, 'USD')).toBe('$1,234.50');
  });

  test('accepts a string input (Decimal-as-string)', () => {
    expect(formatCurrency('1234.5', 'USD')).toBe('$1,234.50');
  });

  test('renders 0.00 for non-finite inputs (Number(NaN) → 0)', () => {
    expect(formatCurrency('not-a-number', 'USD')).toBe('$0.00');
    expect(formatCurrency(Number.POSITIVE_INFINITY, 'USD')).toBe('$0.00');
  });

  test('honors decimals override', () => {
    expect(formatCurrency(1234.567, 'USD', { decimals: 0 })).toBe('$1,235');
    expect(formatCurrency(1234.567, 'USD', { decimals: 4 })).toBe('$1,234.5670');
  });

  test('falls back gracefully when currency is non-ISO', () => {
    expect(formatCurrency(1234.5, 'PRIVATE-EQ')).toMatch(/PRIVATE-EQ\s+1,234\.50/);
  });

  test('honors locale override', () => {
    const eur = formatCurrency(1234.5, 'EUR', { locale: 'de-DE' });
    expect(eur).toContain('€');
    expect(eur).toContain('1.234,50');
  });
});

describe('formatCompact', () => {
  test('uses compact notation above 1000', () => {
    expect(formatCompact(1500, 'USD')).toBe('$1.5K');
    expect(formatCompact(2_500_000, 'USD')).toBe('$2.5M');
  });

  test('falls through to plain formatting below 1000 with 0 default decimals', () => {
    expect(formatCompact(500, 'USD')).toBe('$500');
  });

  test('honors decimals override below threshold', () => {
    expect(formatCompact(500.5, 'USD', { decimals: 2 })).toBe('$500.50');
  });
});

describe('formatNumber', () => {
  test('formats with locale separators (no currency)', () => {
    expect(formatNumber(1234.5)).toBe('1,234.5');
  });

  test('respects fixed decimals', () => {
    expect(formatNumber(1234, { decimals: 2 })).toBe('1,234.00');
  });

  test('renders 0 for non-finite', () => {
    expect(formatNumber('bogus')).toBe('0');
  });
});

describe('getCurrencySymbol', () => {
  test('returns the symbol for known ISO codes', () => {
    expect(getCurrencySymbol('USD')).toBe('$');
    expect(getCurrencySymbol('EUR')).toBe('€');
    expect(getCurrencySymbol('GBP')).toBe('£');
  });

  test('falls back to the code itself for unknown codes', () => {
    expect(getCurrencySymbol('PRIVATE-EQ')).toBe('PRIVATE-EQ');
  });
});

describe('formatBytes', () => {
  test('renders bytes with appropriate unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  test('drops decimal once value crosses 10', () => {
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB');
  });

  test('returns "—" for invalid input', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});
