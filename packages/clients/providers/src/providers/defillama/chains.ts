/**
 * `chainId → DeFiLlama chain name` map for the EVM chains DeFiLlama
 * indexes. The chain name is what its API expects in the `chain:address`
 * query key (e.g. `ethereum:0xA0b8...` for USDC).
 *
 * Pre-refactor location:
 * `packages/pricing-providers/src/defillama-constants.ts`. Same map;
 * adding a chain here is the minimum required to extend pricing
 * coverage to a new EVM L2.
 */

export const CHAIN_ID_TO_DEFILLAMA: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  25: 'cronos',
  56: 'bsc',
  100: 'xdai',
  130: 'unichain',
  137: 'polygon',
  146: 'sonic',
  199: 'bittorrent',
  204: 'op_bnb',
  250: 'fantom',
  252: 'fraxtal',
  324: 'era',
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
  747474: 'katana',
};

/**
 * Minimum confidence the DeFiLlama API must report for a price to be
 * accepted (range 0-1; higher is better, based on liquidity + source
 * quality). Low-confidence tokens are typically scams or freshly-
 * deployed contracts with no real liquidity; treating their price as
 * authoritative would pollute the chart.
 */
export const DEFILLAMA_MIN_CONFIDENCE = 0.8;
