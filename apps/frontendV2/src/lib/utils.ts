import type { Token } from '@scani/shared';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

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
