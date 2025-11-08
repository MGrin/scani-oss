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
  56: 'bsc',
  100: 'xdai', // Gnosis Chain (formerly xDai)
  137: 'polygon',
  250: 'fantom',
  324: 'era', // zkSync Era
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avax',
  59144: 'linea',
  534352: 'scroll',
  // Add more chains as needed
};

/**
 * Minimum confidence score for accepting DeFiLlama price data
 * Range: 0 to 1, where higher values indicate more reliable data
 * Based on liquidity and data source quality
 */
export const DEFILLAMA_MIN_CONFIDENCE = 0.8;
