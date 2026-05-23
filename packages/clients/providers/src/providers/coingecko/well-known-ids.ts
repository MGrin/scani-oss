/**
 * Symbol → CoinGecko slug map for tokens whose CoinGecko id can't be
 * derived from the lowercase symbol. CoinGecko uses long slugs
 * ("ethereum", "usd-coin") rather than tickers ("eth", "usdc"), so
 * symbol-only resolution gets it wrong for most majors.
 *
 * The map is small on purpose — it covers the high-traffic majors
 * we encounter constantly. Anything we don't know goes through the
 * `enrichTokenIdentity` flow which probes CoinGecko's `/coins/list`
 * once and writes the resolved id into `tokens.providerMetadata.coingecko.id`
 * for future calls.
 *
 * Pre-refactor location: `packages/pricing-providers/src/providers/coingecko.ts`.
 */

export const WELL_KNOWN_COINGECKO_IDS: Record<string, string> = {
  eth: 'ethereum',
  btc: 'bitcoin',
  matic: 'matic-network',
  pol: 'pol-ex-matic',
  usdc: 'usd-coin',
  usdt: 'tether',
  bnb: 'binancecoin',
  sol: 'solana',
  avax: 'avalanche-2',
  ada: 'cardano',
  dot: 'polkadot',
  doge: 'dogecoin',
  shib: 'shiba-inu',
  link: 'chainlink',
  uni: 'uniswap',
  xrp: 'ripple',
  ltc: 'litecoin',
  atom: 'cosmos',
  near: 'near',
  steth: 'staked-ether',
  weth: 'weth',
  dai: 'dai',
  trx: 'tron',
  ton: 'the-open-network',
  apt: 'aptos',
  fil: 'filecoin',
  xlm: 'stellar',
  etc: 'ethereum-classic',
  bch: 'bitcoin-cash',
};

/** Resolve a CoinGecko id from either the metadata or the symbol. */
export function resolveCoingeckoId(opts: {
  metadataId?: string | undefined;
  symbol: string;
}): string | null {
  if (opts.metadataId) return opts.metadataId;
  const lower = opts.symbol.toLowerCase();
  return WELL_KNOWN_COINGECKO_IDS[lower] ?? null;
}
