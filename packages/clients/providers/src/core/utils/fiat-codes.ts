/**
 * Best-effort fiat-currency detection for CEX balance snapshots.
 *
 * The token resolver in the import use cases honours
 * `HoldingSnapshot.tokenType`, so any CEX that returns BOTH fiat and
 * crypto balances must stamp the field. Providers that don't will
 * silently route fiat (USD, EUR, …) into the crypto token type and
 * spawn duplicate price-orphan rows.
 *
 * The list below is the ISO 4217 set of "currencies a retail user is
 * realistically holding on a CEX": majors + popular regional fiats.
 * Stablecoins (USDT, USDC, BUSD, FDUSD, DAI, TUSD, …) intentionally
 * stay `crypto` — they trade on CoinGecko / DeFiLlama like any other
 * token, and treating them as fiat would route their pricing through
 * the wrong pipeline.
 *
 * Provider-specific prefixed codes (Kraken's `ZUSD`, `ZEUR`) live in
 * the provider's own normalizer; this helper handles the standard
 * unprefixed codes only.
 */
const FIAT_CODES = new Set<string>([
  // Top 10 by trading volume.
  'USD',
  'EUR',
  'JPY',
  'GBP',
  'AUD',
  'CAD',
  'CHF',
  'CNY',
  'HKD',
  'NZD',
  // Asian + APAC.
  'SGD',
  'KRW',
  'INR',
  'IDR',
  'THB',
  'PHP',
  'MYR',
  'VND',
  'TWD',
  // Europe (non-EUR) + UK-adjacent.
  'NOK',
  'SEK',
  'DKK',
  'PLN',
  'CZK',
  'HUF',
  'RON',
  'BGN',
  'TRY',
  'RUB',
  'UAH',
  // LatAm.
  'BRL',
  'MXN',
  'ARS',
  'CLP',
  'COP',
  'PEN',
  // Middle East + Africa.
  'AED',
  'SAR',
  'ILS',
  'ZAR',
  'NGN',
  'EGP',
]);

export function isFiatCode(code: string): boolean {
  if (!code) return false;
  return FIAT_CODES.has(code.toUpperCase());
}

/**
 * Convenience for CEX providers that need to tag a balance snapshot.
 * `tokenType: isFiatCode(symbol) ? 'fiat' : 'crypto'`.
 */
export function tokenTypeForCexAsset(symbol: string): 'fiat' | 'crypto' {
  return isFiatCode(symbol) ? 'fiat' : 'crypto';
}
