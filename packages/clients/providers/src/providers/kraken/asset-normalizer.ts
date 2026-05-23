/**
 * `normalizeKrakenAsset` — translate Kraken's API-native asset codes
 * into our canonical symbol space.
 *
 * Kraken layers three different mangling rules over the base ticker:
 *
 *   1. **'X' / 'Z' prefixes** (ISO 4217-style): `XXBT` = BTC,
 *      `ZUSD` = USD. Strip the single leading letter when the
 *      remainder is still ≥3 chars.
 *
 *   2. **Earn/staking suffixes** (`.F`, `.B`, `.S`, `.M`, `.P02`,
 *      `.P03`, …): Kraken tags staking, bonded, and flexible variants
 *      of an asset. A user holding earn-ETH still economically holds
 *      ETH — collapsing to the bare ticker keeps every BTC tx
 *      attributable to one holding row instead of fragmenting into
 *      `XBT` / `XBT.F` / `XBT.S`.
 *
 *   3. **Historical aliases**: `XBT` → BTC, `XDG` → DOGE.
 *
 * Order matters: strip suffix first, then prefix, then alias-map.
 */

const HISTORICAL_ALIASES: Record<string, string> = {
  XBT: 'BTC',
  XDG: 'DOGE',
};

export function normalizeKrakenAsset(raw: string): string {
  let symbol = raw;

  // 1. Strip earn/staking/variant suffixes — anything from the first
  //    `.` onward.
  const dotIdx = symbol.indexOf('.');
  if (dotIdx > 0) symbol = symbol.substring(0, dotIdx);

  // 2. Strip the 'X' / 'Z' prefix when the remainder is ≥3 chars.
  //    This is the rule that turns 'XXBT' into 'XBT' (then the
  //    alias map below normalizes that to 'BTC').
  if ((symbol.startsWith('X') || symbol.startsWith('Z')) && symbol.length > 3) {
    symbol = symbol.substring(1);
  }

  // 3. Historical aliases.
  symbol = HISTORICAL_ALIASES[symbol] ?? symbol;

  return symbol.toUpperCase();
}

// Kraken codes for ISO-4217 fiats. Both the Z-prefixed legacy form
// (ZUSD, ZEUR, …) and the bare 3-letter post-2018 form (USD, EUR, …)
// are present in the API depending on asset age. The provider needs
// to stamp `tokenType: 'fiat'` for these so they don't end up in the
// crypto bucket and get routed to CoinGecko / DeFiLlama (which do
// not price fiat currencies).
const FIAT_KRAKEN_CODES = new Set([
  'ZUSD',
  'ZEUR',
  'ZGBP',
  'ZJPY',
  'ZCAD',
  'ZAUD',
  'ZCHF',
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CAD',
  'AUD',
  'CHF',
]);

export function isKrakenFiatAsset(raw: string): boolean {
  // Strip the staking suffix too — `EUR.M` is still EUR.
  const dotIdx = raw.indexOf('.');
  const base = dotIdx > 0 ? raw.substring(0, dotIdx) : raw;
  return FIAT_KRAKEN_CODES.has(base.toUpperCase());
}
