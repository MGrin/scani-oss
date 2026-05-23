/**
 * Symbol normalization + exchange detection for Finnhub.
 *
 * Pre-refactor: lived inside `packages/pricing-providers/src/utils.ts`
 * alongside the shared HTTP utilities. Splitting it out per-provider
 * keeps each provider directory self-describing for OSS contributors —
 * symbol mapping is a Finnhub-specific concern.
 */

/**
 * Strip Finnhub/Yahoo-style prefixes and US-suffixes from a raw
 * symbol so it matches Finnhub's `/quote?symbol=` expectation.
 *
 * Examples:
 *  - `'NASDAQ:AAPL'` → `'AAPL'`
 *  - `'BRK.A'`       → `'BRK.A'`
 *  - `'MSFT.US'`     → `'MSFT'`
 *  - `'AAPL.L'`      → `'AAPL.L'`  (preserved; non-US exchange)
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

/**
 * Map of non-US exchange suffix → exchange + native quote currency.
 * Drives the `finnhub.exchange` metadata field; the orchestrator
 * uses the currency hint to pre-route conversion when the symbol
 * trades in a non-USD currency.
 *
 * US share-class suffixes (`BRK.A`, `BF.B`) are intentionally
 * absent so they stay routed to Finnhub.
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
  PA: { exchange: 'PAR', currency: 'EUR' },
  AS: { exchange: 'AMS', currency: 'EUR' },
  BR: { exchange: 'BRU', currency: 'EUR' },
  LS: { exchange: 'LIS', currency: 'EUR' },
  MI: { exchange: 'MIL', currency: 'EUR' },
  MC: { exchange: 'MAD', currency: 'EUR' },
  VI: { exchange: 'VIE', currency: 'EUR' },
  DE: { exchange: 'XETRA', currency: 'EUR' },
  F: { exchange: 'FRA', currency: 'EUR' },
  MU: { exchange: 'MUN', currency: 'EUR' },
  BE: { exchange: 'BER', currency: 'EUR' },
  SG: { exchange: 'STU', currency: 'EUR' },
  HM: { exchange: 'HAM', currency: 'EUR' },
  HA: { exchange: 'HAN', currency: 'EUR' },
  HE: { exchange: 'HEL', currency: 'EUR' },
  IR: { exchange: 'ISE', currency: 'EUR' },
  // Nordic / Switzerland
  SW: { exchange: 'SIX', currency: 'CHF' },
  ST: { exchange: 'STO', currency: 'SEK' },
  OL: { exchange: 'OSL', currency: 'NOK' },
  CO: { exchange: 'CPH', currency: 'DKK' },
  IC: { exchange: 'ICE', currency: 'ISK' },
  // Asia
  T: { exchange: 'TYO', currency: 'JPY' },
  HK: { exchange: 'HKG', currency: 'HKD' },
  SS: { exchange: 'SHA', currency: 'CNY' },
  SZ: { exchange: 'SHE', currency: 'CNY' },
  KS: { exchange: 'KRX', currency: 'KRW' },
  KQ: { exchange: 'KOSDAQ', currency: 'KRW' },
  SI: { exchange: 'SGX', currency: 'SGD' },
  BK: { exchange: 'SET', currency: 'THB' },
  TW: { exchange: 'TPE', currency: 'TWD' },
  TWO: { exchange: 'TPEX', currency: 'TWD' },
  JK: { exchange: 'IDX', currency: 'IDR' },
  NS: { exchange: 'NSE', currency: 'INR' },
  BO: { exchange: 'BSE', currency: 'INR' },
  // Pacific
  AX: { exchange: 'ASX', currency: 'AUD' },
  NZ: { exchange: 'NZX', currency: 'NZD' },
  // LatAm
  SA: { exchange: 'B3', currency: 'BRL' },
  MX: { exchange: 'BMV', currency: 'MXN' },
  BA: { exchange: 'BCBA', currency: 'ARS' },
  CL: { exchange: 'BCS', currency: 'CLP' },
  // Africa / MENA
  JO: { exchange: 'JSE', currency: 'ZAR' },
  CA: { exchange: 'EGX', currency: 'EGP' },
  // CIS / CEE / Middle East
  ME: { exchange: 'MOEX', currency: 'RUB' },
  IS: { exchange: 'BIST', currency: 'TRY' },
  WA: { exchange: 'WSE', currency: 'PLN' },
  TA: { exchange: 'TASE', currency: 'ILS' },
  SR: { exchange: 'TADAWUL', currency: 'SAR' },
};

/**
 * Detect exchange + currency from a symbol's suffix. Returns null
 * for US listings (no suffix) or unknown suffixes.
 */
export function detectExchangeInfo(symbol: string): { exchange: string; currency: string } | null {
  if (!symbol) return null;
  const dotIdx = symbol.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const suffix = symbol.slice(dotIdx + 1).toUpperCase();
  return NON_US_EXCHANGE_SUFFIX_MAP[suffix] ?? null;
}
