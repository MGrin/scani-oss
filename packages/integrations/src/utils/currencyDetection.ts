/**
 * Shared utility for detecting fiat currencies in exchange holdings.
 * Exchanges return fiat balances (USD, EUR, GBP, etc.) alongside crypto,
 * but most integrations don't distinguish them. This utility provides
 * consistent fiat detection across all exchange integrations.
 */

const FIAT_SYMBOLS = new Set([
  'USD',
  'EUR',
  'GBP',
  'CHF',
  'CAD',
  'AUD',
  'JPY',
  'CNY',
  'KRW',
  'RUB',
  'INR',
  'BRL',
  'MXN',
  'SGD',
  'HKD',
  'NZD',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'TRY',
  'ZAR',
  'AED',
  'SAR',
  'THB',
  'TWD',
  'ILS',
  'ARS',
  'CLP',
  'COP',
  'PHP',
  'IDR',
  'MYR',
  'VND',
  'UAH',
  'KZT',
  'GEL',
  'RON',
  'BGN',
  'HUF',
  'ISK',
  'NGN',
  'KES',
  'EGP',
  'PKR',
  'BDT',
  'QAR',
  'OMR',
  'KWD',
  'BHD',
  'JOD',
]);

/**
 * Detect whether a symbol represents a fiat currency.
 * Strips common exchange suffixes (e.g., ".HOLD" from Kraken's "EUR.HOLD").
 */
export function detectTokenType(symbol: string): 'fiat' | 'crypto' {
  const upper = symbol.toUpperCase().replace(/\.HOLD$/, '');
  return FIAT_SYMBOLS.has(upper) ? 'fiat' : 'crypto';
}
