/**
 * Shared constants for DeFiLlama integration
 * Used across pricing providers and token validation services
 */

/**
 * Mapping of chainId to DeFiLlama chain names
 * See: https://defillama.com/docs/api
 */
export const CHAIN_ID_TO_DEFILLAMA: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  25: 'cronos',
  56: 'bsc',
  100: 'xdai', // Gnosis Chain (formerly xDai)
  130: 'unichain',
  137: 'polygon',
  146: 'sonic',
  199: 'bittorrent',
  204: 'op_bnb',
  250: 'fantom',
  252: 'fraxtal',
  324: 'era', // zkSync Era
  480: 'worldchain',
  1284: 'moonbeam',
  1285: 'moonriver',
  1329: 'sei',
  1923: 'swellchain',
  2741: 'abstract',
  5000: 'mantle',
  8453: 'base',
  33139: 'apechain',
  42161: 'arbitrum',
  42170: 'arbitrum_nova',
  42220: 'celo',
  43114: 'avax',
  50104: 'sophon',
  59144: 'linea',
  80094: 'berachain',
  81457: 'blast',
  167000: 'taiko',
  534352: 'scroll',
  747474: 'katana', // Flow EVM
};

/**
 * Minimum confidence score for accepting DeFiLlama price data
 * Range: 0 to 1, where higher values indicate more reliable data
 * Based on liquidity and data source quality
 */
export const DEFILLAMA_MIN_CONFIDENCE = 0.8;
