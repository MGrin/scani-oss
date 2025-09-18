import { Decimal } from 'decimal.js';

// Configure Decimal.js for financial calculations
Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -7,
  toExpPos: 21,
  minE: -9e15,
  maxE: 9e15,
  crypto: false,
  modulo: Decimal.ROUND_DOWN,
});

export { Decimal };

/**
 * Financial calculation utilities using Decimal.js for precision
 */
export namespace FinancialMath {
  /**
   * Add two monetary values
   */
  export function add(a: number | string | Decimal, b: number | string | Decimal): Decimal {
    return new Decimal(a).plus(new Decimal(b));
  }

  /**
   * Subtract two monetary values
   */
  export function subtract(a: number | string | Decimal, b: number | string | Decimal): Decimal {
    return new Decimal(a).minus(new Decimal(b));
  }

  /**
   * Multiply monetary value by a factor
   */
  export function multiply(a: number | string | Decimal, b: number | string | Decimal): Decimal {
    return new Decimal(a).times(new Decimal(b));
  }

  /**
   * Divide monetary values
   */
  export function divide(a: number | string | Decimal, b: number | string | Decimal): Decimal {
    return new Decimal(a).dividedBy(new Decimal(b));
  }

  /**
   * Get absolute value
   */
  export function abs(value: number | string | Decimal): Decimal {
    return new Decimal(value).abs();
  }

  /**
   * Compare two values (-1, 0, 1)
   */
  export function compare(a: number | string | Decimal, b: number | string | Decimal): number {
    return new Decimal(a).comparedTo(new Decimal(b));
  }

  /**
   * Check if values are equal
   */
  export function equals(a: number | string | Decimal, b: number | string | Decimal): boolean {
    return new Decimal(a).equals(new Decimal(b));
  }

  /**
   * Check if a > b
   */
  export function greaterThan(a: number | string | Decimal, b: number | string | Decimal): boolean {
    return new Decimal(a).greaterThan(new Decimal(b));
  }

  /**
   * Check if a < b
   */
  export function lessThan(a: number | string | Decimal, b: number | string | Decimal): boolean {
    return new Decimal(a).lessThan(new Decimal(b));
  }

  /**
   * Format as currency string using Intl.NumberFormat (e.g., "$1,234.56")
   * When style is 'currency', currency parameter is required
   */
  export function formatCurrency(
    value: number | string | Decimal,
    options: {
      currency?: string;
      locale?: string;
      decimals?: number;
      style?: 'currency' | 'decimal';
    } = {}
  ): string {
    const { currency, locale = 'en-US', decimals = 2, style = 'decimal' } = options;

    const decimal = new Decimal(value);
    const numericValue = decimal.toNumber();

    if (style === 'currency') {
      if (!currency) {
        throw new Error('Currency is required when style is "currency"');
      }

      try {
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(numericValue);
      } catch (_error) {
        // If currency is unsupported, fall back to decimal format with currency symbol
        return `${getCurrencySymbol(currency, locale)}${new Intl.NumberFormat(locale, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(numericValue)}`;
      }
    } else {
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(numericValue);
    }
  }

  /**
   * Legacy formatCurrency function for backward compatibility
   */
  export function formatCurrencyLegacy(
    value: number | string | Decimal,
    decimals = 2,
    symbol = '$'
  ): string {
    const decimal = new Decimal(value);
    const formatted = decimal.toFixed(decimals);

    // Add thousand separators
    const parts = formatted.split('.');
    if (parts[0]) {
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    return `${symbol}${parts.join('.')}`;
  }

  /**
   * Round to specified decimal places for display
   */
  export function round(value: number | string | Decimal, decimals = 2): Decimal {
    return new Decimal(value).toDecimalPlaces(decimals);
  }

  /**
   * Convert to number (use only for display, not calculations)
   */
  export function toNumber(value: Decimal): number {
    return value.toNumber();
  }

  /**
   * Sum an array of values
   */
  export function sum(values: (number | string | Decimal)[]): Decimal {
    return values.reduce<Decimal>((acc, val) => acc.plus(new Decimal(val)), new Decimal(0));
  }

  /**
   * Calculate percentage
   */
  export function percentage(
    value: number | string | Decimal,
    total: number | string | Decimal
  ): Decimal {
    if (new Decimal(total).equals(0)) {
      return new Decimal(0);
    }
    return new Decimal(value).dividedBy(new Decimal(total)).times(100);
  }

  /**
   * Calculate percentage change
   */
  export function percentageChange(
    oldValue: number | string | Decimal,
    newValue: number | string | Decimal
  ): Decimal {
    if (new Decimal(oldValue).equals(0)) {
      return new Decimal(0);
    }
    return new Decimal(newValue)
      .minus(new Decimal(oldValue))
      .dividedBy(new Decimal(oldValue))
      .times(100);
  }

  /**
   * Calculate compound interest
   */
  export function compoundInterest(
    principal: number | string | Decimal,
    rate: number | string | Decimal,
    periods: number,
    compounding: number = 1
  ): Decimal {
    const p = new Decimal(principal);
    const r = new Decimal(rate).dividedBy(100);
    const n = new Decimal(compounding);
    const t = new Decimal(periods);

    // A = P(1 + r/n)^(nt)
    return p.times(new Decimal(1).plus(r.dividedBy(n)).pow(n.times(t)));
  }

  /**
   * Parse string to Decimal, handling various formats and locales
   */
  export function parse(value: string, locale = 'en-US'): Decimal {
    // Handle different decimal separators based on locale
    let cleaned = value.trim();

    // Remove currency symbols first
    cleaned = cleaned.replace(/[^\d.,\-+]/g, '');

    // Handle different decimal separators
    if (locale.includes('de') || locale.includes('fr') || locale.includes('es')) {
      // European format: 1.234,56 (dot for thousands, comma for decimal)
      if (cleaned.includes(',') && cleaned.includes('.')) {
        // Both present: assume dot is thousand separator
        cleaned = cleaned.replace(/\./g, '').replace(',', '.');
      } else if (cleaned.includes(',')) {
        // Only comma: assume it's decimal separator
        cleaned = cleaned.replace(',', '.');
      }
    } else {
      // Default format: 1,234.56 (comma for thousands, dot for decimal)
      if (cleaned.includes(',') && cleaned.includes('.')) {
        // Both present: remove commas
        cleaned = cleaned.replace(/,/g, '');
      } else if (cleaned.includes(',') && !cleaned.includes('.')) {
        // Only comma: could be thousand separator or decimal
        const commaIndex = cleaned.lastIndexOf(',');
        const afterComma = cleaned.substring(commaIndex + 1);
        if (afterComma.length <= 3 && !/^\d{3}$/.test(afterComma)) {
          // Likely decimal separator
          cleaned = cleaned.replace(',', '.');
        } else {
          // Likely thousand separator
          cleaned = cleaned.replace(/,/g, '');
        }
      }
    }

    return new Decimal(cleaned);
  }

  /**
   * Check if value is zero
   */
  export function isZero(value: number | string | Decimal): boolean {
    return new Decimal(value).isZero();
  }

  /**
   * Get minimum value
   */
  export function min(...values: (number | string | Decimal)[]): Decimal {
    if (values.length === 0) {
      throw new Error('Cannot get minimum of empty array');
    }
    // Since we check length > 0 above, values[0] is guaranteed to exist
    const firstValue = values[0] as number | string | Decimal;
    return values.reduce<Decimal>((min, val) => {
      const decimal = new Decimal(val);
      return decimal.lessThan(min) ? decimal : min;
    }, new Decimal(firstValue));
  }

  /**
   * Get maximum value
   */
  export function max(...values: (number | string | Decimal)[]): Decimal {
    if (values.length === 0) {
      throw new Error('Cannot get maximum of empty array');
    }
    // Since we check length > 0 above, values[0] is guaranteed to exist
    const firstValue = values[0] as number | string | Decimal;
    return values.reduce<Decimal>((max, val) => {
      const decimal = new Decimal(val);
      return decimal.greaterThan(max) ? decimal : max;
    }, new Decimal(firstValue));
  }

  /**
   * Get currency symbol for a given currency code
   * Primarily uses Intl.NumberFormat with minimal fallback
   */
  export function getCurrencySymbol(currencyCode: string, locale = 'en-US'): string {
    try {
      const formatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currencyCode,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });
      // Extract symbol from formatted zero
      const formatted = formatter.format(0);
      return formatted.replace(/[\d\s]/g, '');
    } catch (_error) {
      // Minimal fallback for common currencies only
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
   * Convert between currencies using exchange rates
   * This is a placeholder - in a real implementation you'd fetch from an API
   */
  export function convertCurrency(
    amount: number | string | Decimal,
    fromCurrency: string,
    toCurrency: string,
    exchangeRate?: number
  ): Decimal {
    if (fromCurrency === toCurrency) {
      return new Decimal(amount);
    }

    if (!exchangeRate) {
      // Placeholder - in real implementation, fetch from API
      console.warn(`Exchange rate not provided for ${fromCurrency} to ${toCurrency}`);
      return new Decimal(amount);
    }

    return new Decimal(amount).times(exchangeRate);
  }
}
