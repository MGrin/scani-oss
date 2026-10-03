/**
 * EVM chain catalog for the Etherscan V2 unified API.
 *
 * Etherscan V2 (`https://api.etherscan.io/v2/api?chainid={id}&...`)
 * exposes every supported chain through a single endpoint, so adding
 * a new chain is just a row here — but only for a chain id listed by
 * `https://api.etherscan.io/v2/chainlist`. Any other id is refused before
 * the key is read, so the chain fails on every import and every sync
 * (SC-1524); `tests/providers/etherscan/chains.test.ts` holds the snapshot.
 *
 * Pre-refactor source: `packages/integrations/src/blockchain-services/chain-config.ts`.
 * Same content, scoped down to the fields the provider actually uses
 * — `name`, `native*`, and the institution code the registry routes
 * by. CoinGecko/DeFiLlama platform ids stay co-located with their own
 * provider directories.
 */

import type { EvmChainConfig } from '../../core/base/base-evm-provider';

/**
 * The chain catalog. `institutionCode` is what the orchestrator's
 * `canFetchBalances(...)` is asked about; one provider instance is
 * registered per chain so the registry's filter can short-circuit
 * by institution.
 */
export const ETHERSCAN_CHAINS: readonly EvmChainConfig[] = [
  // Tier 1
  {
    chainId: 1,
    institutionCode: 'ethereum',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    nativeDecimals: 18,
    wrappedNative: {
      contractAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      symbol: 'WETH',
      name: 'Wrapped Ether',
    },
  },
  {
    chainId: 56,
    institutionCode: 'bsc',
    nativeSymbol: 'BNB',
    nativeName: 'Binance Coin',
    nativeDecimals: 18,
  },
  {
    chainId: 137,
    institutionCode: 'polygon',
    nativeSymbol: 'MATIC',
    nativeName: 'Polygon',
    nativeDecimals: 18,
  },
  {
    chainId: 43114,
    institutionCode: 'avalanche',
    nativeSymbol: 'AVAX',
    nativeName: 'Avalanche',
    nativeDecimals: 18,
  },
  {
    chainId: 42161,
    institutionCode: 'arbitrum',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    nativeDecimals: 18,
  },
  {
    chainId: 10,
    institutionCode: 'optimism',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    nativeDecimals: 18,
  },
  {
    chainId: 8453,
    institutionCode: 'base',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    nativeDecimals: 18,
  },
  // Tier 2 / L2s
  {
    chainId: 59144,
    institutionCode: 'linea',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    nativeDecimals: 18,
  },
  {
    chainId: 81457,
    institutionCode: 'blast',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    nativeDecimals: 18,
  },
  {
    chainId: 5000,
    institutionCode: 'mantle',
    nativeSymbol: 'MNT',
    nativeName: 'Mantle',
    nativeDecimals: 18,
  },
  {
    chainId: 204,
    institutionCode: 'opbnb',
    nativeSymbol: 'BNB',
    nativeName: 'Binance Coin',
    nativeDecimals: 18,
  },
  // Tier 3
  {
    chainId: 100,
    institutionCode: 'gnosis',
    nativeSymbol: 'xDAI',
    nativeName: 'xDAI',
    nativeDecimals: 18,
  },
  {
    chainId: 42220,
    institutionCode: 'celo',
    nativeSymbol: 'CELO',
    nativeName: 'Celo',
    nativeDecimals: 18,
  },
];

export function findChainConfig(institutionCode: string): EvmChainConfig | null {
  return ETHERSCAN_CHAINS.find((c) => c.institutionCode === institutionCode) ?? null;
}
