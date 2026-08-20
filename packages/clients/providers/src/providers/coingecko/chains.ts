/**
 * `chainId → CoinGecko asset-platform id` map, mirroring
 * `../defillama/chains.ts`. CoinGecko keys a coin's `platforms` object
 * by these ids (`ethereum`, `polygon-pos`, `optimistic-ethereum`, …),
 * which is the vocabulary the canonical-deployment table in
 * `./well-known-ids.ts` is written in.
 *
 * Sourced from CoinGecko's `/asset_platforms` endpoint, filtered to the
 * chains `../etherscan/chains.ts` can produce a contract address for —
 * an entry here is only useful if an EVM provider can hand us a token
 * on that chain.
 */

export const CHAIN_ID_TO_COINGECKO_PLATFORM: Record<number, string> = {
  1: 'ethereum',
  10: 'optimistic-ethereum',
  25: 'cronos',
  56: 'binance-smart-chain',
  100: 'xdai',
  137: 'polygon-pos',
  204: 'opbnb',
  250: 'fantom',
  324: 'zksync',
  1284: 'moonbeam',
  1285: 'moonriver',
  5000: 'mantle',
  8453: 'base',
  42161: 'arbitrum-one',
  42170: 'arbitrum-nova',
  42220: 'celo',
  43114: 'avalanche',
  59144: 'linea',
  81457: 'blast',
  534352: 'scroll',
};

/** CoinGecko's platform id for Solana; SPL mints live under this key. */
export const COINGECKO_SOLANA_PLATFORM = 'solana';
