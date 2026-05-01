import type { Token } from '@scani/shared';

export { cn } from '@scani/ui/lib/cn';

/**
 * Create a currency token object for display purposes
 * This creates a mock Token object for fiat currencies
 */
export function createCurrencyToken(currencySymbol: string): Token {
  const currencyNames: Record<string, string> = {
    USD: 'US Dollar',
    EUR: 'Euro',
    GBP: 'British Pound',
    JPY: 'Japanese Yen',
    CAD: 'Canadian Dollar',
    AUD: 'Australian Dollar',
    CHF: 'Swiss Franc',
    CNY: 'Chinese Yuan',
    SEK: 'Swedish Krona',
    NZD: 'New Zealand Dollar',
    MXN: 'Mexican Peso',
    SGD: 'Singapore Dollar',
    HKD: 'Hong Kong Dollar',
    NOK: 'Norwegian Krone',
    KRW: 'South Korean Won',
    TRY: 'Turkish Lira',
    RUB: 'Russian Ruble',
    INR: 'Indian Rupee',
    BRL: 'Brazilian Real',
    ZAR: 'South African Rand',
  };

  return {
    id: `currency-${currencySymbol}`,
    symbol: currencySymbol,
    name: currencyNames[currencySymbol] || `${currencySymbol} Currency`,
    decimals: 2,
    iconUrl: null,
    isActive: true,
    typeId: '',
    providerMetadata: '',
  };
}

/**
 * Normalize a symbol string
 */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Format an interval string (e.g., "2w", "3M") into a human-readable description
 */
export function formatInterval(interval: string): string {
  const match = interval.match(/^(\d+)(d|w|M|y)$/);
  if (!match?.[1] || !match[2]) return interval;

  const value = match[1];
  const unit = match[2];
  const unitNames: Record<string, string> = {
    d: 'day',
    w: 'week',
    M: 'month',
    y: 'year',
  };

  const unitName = unitNames[unit] || unit;
  const plural = value !== '1' ? 's' : '';

  return `Every ${value} ${unitName}${plural}`;
}
