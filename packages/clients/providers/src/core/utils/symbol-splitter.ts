/**
 * Concatenated trading-pair splitter for exchanges that report symbols
 * without a delimiter (Binance `BTCUSDT`, Bybit `BTCUSD`, MEXC, Bitget,
 * Huobi). Bitstamp is *not* in this group — its API keys pairs as
 * `btcusd` / `btceur` strings on a per-pair object map, so it splits
 * via lookup, not heuristic.
 *
 * The caller passes the candidate quote-asset list in priority order
 * (longest / most specific first). Iteration matches by suffix; the
 * first hit wins. Ordering matters whenever one quote is a suffix of
 * another (`BUSD` would be eclipsed by `USD` if `USD` came first), so
 * the default list lists multi-character stablecoins ahead of plain
 * `USD`.
 */

export const DEFAULT_CONCATENATED_QUOTE_ASSETS: readonly string[] = [
  'USDT',
  'USDC',
  'FDUSD',
  'BUSD',
  'TUSD',
  'DAI',
  'USD',
  'EUR',
  'GBP',
  'TRY',
  'BRL',
  'BTC',
  'ETH',
  'BNB',
] as const;

/**
 * Split a concatenated trading pair (`BTCUSDT`) into its base and quote
 * components, returning `null` if no candidate quote asset matches as a
 * suffix or if the resulting base would be empty.
 *
 * `quoteAssetsLongestFirst` is the candidate list in priority order —
 * the function trusts the caller's ordering and does not re-sort.
 */
export function splitConcatenatedPair(
  pair: string,
  quoteAssetsLongestFirst: readonly string[] = DEFAULT_CONCATENATED_QUOTE_ASSETS
): { base: string; quote: string } | null {
  if (!pair) return null;
  const upper = pair.toUpperCase();
  for (const quote of quoteAssetsLongestFirst) {
    if (!quote) continue;
    if (upper.length <= quote.length) continue;
    if (upper.endsWith(quote)) {
      const base = upper.slice(0, upper.length - quote.length);
      if (!base) return null;
      return { base, quote };
    }
  }
  return null;
}
