/**
 * Symbol-suffix → exchange-info heuristic. Used both by
 * `@scani/providers-google-sheets` (route non-US Finnhub symbols
 * through GOOGLEFINANCE) and by `@scani/domain` TokenValidationService
 * (decide which provider to discriminate to during token enrichment).
 *
 * Lives here rather than in the google-sheets sub-workspace because
 * domain code references it without otherwise needing the
 * googleapis-bearing tree.
 */

/**
 * Map Finnhub/Yahoo-style symbol suffixes to exchange + quoted-currency.
 * Finnhub's free tier only prices US-listed symbols — anything with a
 * non-US suffix needs to route through Google Sheets (GOOGLEFINANCE).
 *
 * US share classes (`BRK.A`, `BF.B`, …) deliberately aren't in this map
 * so they stay on Finnhub.
 */
export const NON_US_EXCHANGE_SUFFIX_MAP: Record<string, { exchange: string; currency: string }> = {
  // Canada
  TO: { exchange: 'TSX', currency: 'CAD' },
  V: { exchange: 'TSXV', currency: 'CAD' },
  NE: { exchange: 'NEO', currency: 'CAD' },
  CN: { exchange: 'CSE', currency: 'CAD' },
  // UK
  L: { exchange: 'LSE', currency: 'GBP' },
  IL: { exchange: 'LSE', currency: 'USD' },
  AQ: { exchange: 'AQSE', currency: 'GBP' },
  // Euronext / continental Europe
  DE: { exchange: 'XETRA', currency: 'EUR' },
  F: { exchange: 'FRA', currency: 'EUR' },
  PA: { exchange: 'EURONEXT', currency: 'EUR' },
  AS: { exchange: 'AMS', currency: 'EUR' },
  BR: { exchange: 'BRU', currency: 'EUR' },
  LS: { exchange: 'LIS', currency: 'EUR' },
  MI: { exchange: 'BIT', currency: 'EUR' },
  MC: { exchange: 'BME', currency: 'EUR' },
  ST: { exchange: 'STO', currency: 'SEK' },
  HE: { exchange: 'HEL', currency: 'EUR' },
  CO: { exchange: 'CPH', currency: 'DKK' },
  OL: { exchange: 'OSE', currency: 'NOK' },
  WA: { exchange: 'WSE', currency: 'PLN' },
  PR: { exchange: 'PSE', currency: 'CZK' },
  IS: { exchange: 'IST', currency: 'TRY' },
  AT: { exchange: 'ATH', currency: 'EUR' },
  SW: { exchange: 'SWX', currency: 'CHF' },
  // Asia/Pacific
  T: { exchange: 'TYO', currency: 'JPY' },
  HK: { exchange: 'HKEX', currency: 'HKD' },
  SS: { exchange: 'SHA', currency: 'CNY' },
  SZ: { exchange: 'SHE', currency: 'CNY' },
  KS: { exchange: 'KRX', currency: 'KRW' },
  KQ: { exchange: 'KOSDAQ', currency: 'KRW' },
  TW: { exchange: 'TPE', currency: 'TWD' },
  AX: { exchange: 'ASX', currency: 'AUD' },
  NZ: { exchange: 'NZX', currency: 'NZD' },
  SI: { exchange: 'SGX', currency: 'SGD' },
  BO: { exchange: 'BOM', currency: 'INR' },
  NS: { exchange: 'NSE', currency: 'INR' },
  TA: { exchange: 'TLV', currency: 'ILS' },
  // Africa
  JO: { exchange: 'JSE', currency: 'ZAR' },
  // South America
  SA: { exchange: 'BVMF', currency: 'BRL' },
  BA: { exchange: 'BCBA', currency: 'ARS' },
  // Russia
  ME: { exchange: 'MISX', currency: 'RUB' },
};

/**
 * Inferred exchange info for a stock based on its symbol suffix
 * (e.g. `RY.TO` → TSX/CAD). Returns null for plain US symbols (and
 * special-case US share classes), letting the caller short-circuit
 * to Finnhub.
 */
export function detectExchangeInfoFromSuffix(
  symbol: string
): { exchange: string; currency: string } | null {
  if (!symbol) return null;
  const dot = symbol.lastIndexOf('.');
  if (dot < 0 || dot === symbol.length - 1) return null;
  const suffix = symbol.slice(dot + 1).toUpperCase();
  return NON_US_EXCHANGE_SUFFIX_MAP[suffix] ?? null;
}

export function parseInternationalNumber(value: string | null | undefined): number | null {
  if (!value || typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  let parsed = Number(cleaned);
  if (!Number.isNaN(parsed)) return parsed;
  // European format: comma decimal separator.
  const europeanFormat = cleaned.replace(',', '.');
  parsed = Number(europeanFormat);
  if (!Number.isNaN(parsed)) return parsed;
  return null;
}

export function isValidPrice(value: string | null | undefined): boolean {
  const parsed = parseInternationalNumber(value);
  return parsed !== null && parsed > 0;
}

/**
 * Strip non-symbol characters from a Google Finance ticker. Allows
 * uppercase A-Z, digits, dots, hyphens, and colons (for exchange-
 * prefixed symbols). Caps length at 32 chars to fit Google Sheets cell
 * limits and prevent accidental injection.
 */
export function sanitizeForGoogleFinanceSymbol(symbol: string): string {
  if (!symbol) return '';
  const upper = symbol.toString().toUpperCase().trim();
  const sanitized = upper.replace(/[^A-Z0-9.\-:]/g, '');
  return sanitized.slice(0, 32);
}

/**
 * Lower-cased Finnhub-symbol normalizer: drop exchange prefixes
 * (NASDAQGS:, NASDAQ:, NYSE:, …), drop `:US`/`.US` suffixes, and strip
 * the residual non-symbol characters.
 */
export function normalizeForFinnhubSymbol(raw: string): string {
  if (!raw) return '';
  let s = raw.toUpperCase().trim();
  s = s.replace(
    /^(NASDAQGS:|NASDAQCM:|NASDAQ:|NYSEARCA:|NYSEAMERICAN:|NYSEMKT:|NYSE:|ARCA:|BATS:)/,
    ''
  );
  s = s.replace(/(:US|\.US)$/i, '');
  s = s.replace(/[^A-Z0-9.-]/g, '');
  return s;
}
