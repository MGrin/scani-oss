/**
 * Configuration for all supported blockchain chains
 * Based on Etherscan V2 API supported chains: https://docs.etherscan.io/introduction
 *
 * NOTE: All EVM chains use the unified Etherscan V2 API endpoint:
 * https://api.etherscan.io/v2/api with chainid parameter
 */

/**
 * Chain configuration
 */
export interface ChainConfig {
  /** Chain ID (EIP-155 for EVM chains) */
  chainId: number | string;
  /** Human-readable chain name */
  name: string;
  /** Chain type (evm, bitcoin, solana, tron, ton) */
  type: 'evm' | 'bitcoin' | 'solana' | 'tron' | 'ton';
  /** Native token symbol */
  nativeSymbol: string;
  /** Native token name */
  nativeName: string;
  /** Etherscan V2 API base URL (unified endpoint for all EVM chains) */
  explorerApiUrl?: string;
  /** DeFiLlama chain name for pricing */
  defiLlamaId?: string;
  /** CoinGecko platform ID */
  coinGeckoPlatformId?: string;
  /** Icon URL */
  iconUrl?: string;
  /** Whether chain is active */
  isActive: boolean;
}

/**
 * All supported EVM chains from Etherscan V2 API
 * No testnets included (production only)
 *
 * NOTE: All chains now use the unified Etherscan V2 endpoint.
 * The chainId parameter is appended in evm-chain-service.ts
 */
export const EVM_CHAINS: Record<string, ChainConfig> = {
  // Tier 1 - Major chains
  ethereum: {
    chainId: 1,
    name: 'Ethereum',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'ethereum',
    coinGeckoPlatformId: 'ethereum',
    isActive: true,
  },
  bsc: {
    chainId: 56,
    name: 'Binance Smart Chain',
    type: 'evm',
    nativeSymbol: 'BNB',
    nativeName: 'Binance Coin',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'bsc',
    coinGeckoPlatformId: 'binance-smart-chain',
    isActive: true,
  },
  polygon: {
    chainId: 137,
    name: 'Polygon',
    type: 'evm',
    nativeSymbol: 'MATIC',
    nativeName: 'Polygon',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'polygon',
    coinGeckoPlatformId: 'polygon-pos',
    isActive: true,
  },
  avalanche: {
    chainId: 43114,
    name: 'Avalanche',
    type: 'evm',
    nativeSymbol: 'AVAX',
    nativeName: 'Avalanche',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'avax',
    coinGeckoPlatformId: 'avalanche',
    isActive: true,
  },
  arbitrum: {
    chainId: 42161,
    name: 'Arbitrum',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'arbitrum',
    coinGeckoPlatformId: 'arbitrum-one',
    isActive: true,
  },
  optimism: {
    chainId: 10,
    name: 'Optimism',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'optimism',
    coinGeckoPlatformId: 'optimistic-ethereum',
    isActive: true,
  },
  base: {
    chainId: 8453,
    name: 'Base',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'base',
    coinGeckoPlatformId: 'base',
    isActive: true,
  },
  fantom: {
    chainId: 250,
    name: 'Fantom',
    type: 'evm',
    nativeSymbol: 'FTM',
    nativeName: 'Fantom',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'fantom',
    coinGeckoPlatformId: 'fantom',
    isActive: true,
  },
  cronos: {
    chainId: 25,
    name: 'Cronos',
    type: 'evm',
    nativeSymbol: 'CRO',
    nativeName: 'Cronos',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'cronos',
    coinGeckoPlatformId: 'cronos',
    isActive: true,
  },

  // Tier 2 - Layer 2s and Sidechains
  'arbitrum-nova': {
    chainId: 42170,
    name: 'Arbitrum Nova',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'arbitrum_nova',
    isActive: true,
  },
  'zksync-era': {
    chainId: 324,
    name: 'zkSync Era',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'era',
    coinGeckoPlatformId: 'zksync',
    isActive: true,
  },
  scroll: {
    chainId: 534352,
    name: 'Scroll',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'scroll',
    isActive: true,
  },
  linea: {
    chainId: 59144,
    name: 'Linea',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'linea',
    isActive: true,
  },
  blast: {
    chainId: 81457,
    name: 'Blast',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'blast',
    isActive: true,
  },
  mantle: {
    chainId: 5000,
    name: 'Mantle',
    type: 'evm',
    nativeSymbol: 'MNT',
    nativeName: 'Mantle',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'mantle',
    isActive: true,
  },
  opbnb: {
    chainId: 204,
    name: 'opBNB',
    type: 'evm',
    nativeSymbol: 'BNB',
    nativeName: 'Binance Coin',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'opbnb',
    isActive: true,
  },

  // Tier 3 - Other EVM chains
  gnosis: {
    chainId: 100,
    name: 'Gnosis',
    type: 'evm',
    nativeSymbol: 'xDAI',
    nativeName: 'xDAI',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'xdai',
    coinGeckoPlatformId: 'xdai',
    isActive: true,
  },
  celo: {
    chainId: 42220,
    name: 'Celo',
    type: 'evm',
    nativeSymbol: 'CELO',
    nativeName: 'Celo',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'celo',
    coinGeckoPlatformId: 'celo',
    isActive: true,
  },
  moonbeam: {
    chainId: 1284,
    name: 'Moonbeam',
    type: 'evm',
    nativeSymbol: 'GLMR',
    nativeName: 'Glimmer',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'moonbeam',
    coinGeckoPlatformId: 'moonbeam',
    isActive: true,
  },
  moonriver: {
    chainId: 1285,
    name: 'Moonriver',
    type: 'evm',
    nativeSymbol: 'MOVR',
    nativeName: 'Moonriver',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'moonriver',
    coinGeckoPlatformId: 'moonriver',
    isActive: true,
  },
  fraxtal: {
    chainId: 252,
    name: 'Fraxtal',
    type: 'evm',
    nativeSymbol: 'frxETH',
    nativeName: 'Frax Ether',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'fraxtal',
    isActive: true,
  },
  ronin: {
    chainId: 747474,
    name: 'Ronin',
    type: 'evm',
    nativeSymbol: 'RON',
    nativeName: 'Ronin',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    defiLlamaId: 'ronin',
    isActive: true,
  },
  xdc: {
    chainId: 50,
    name: 'XDC Network',
    type: 'evm',
    nativeSymbol: 'XDC',
    nativeName: 'XDC',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  bittorrent: {
    chainId: 199,
    name: 'BitTorrent Chain',
    type: 'evm',
    nativeSymbol: 'BTT',
    nativeName: 'BitTorrent',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },

  // Newer chains (2024-2025)
  berachain: {
    chainId: 80094,
    name: 'Berachain',
    type: 'evm',
    nativeSymbol: 'BERA',
    nativeName: 'Berachain',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  sei: {
    chainId: 1329,
    name: 'Sei',
    type: 'evm',
    nativeSymbol: 'SEI',
    nativeName: 'Sei',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  sonic: {
    chainId: 146,
    name: 'Sonic',
    type: 'evm',
    nativeSymbol: 'S',
    nativeName: 'Sonic',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  sophon: {
    chainId: 50104,
    name: 'Sophon',
    type: 'evm',
    nativeSymbol: 'SOPH',
    nativeName: 'Sophon',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  swellchain: {
    chainId: 1923,
    name: 'Swellchain',
    type: 'evm',
    nativeSymbol: 'swETH',
    nativeName: 'Swell Ether',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  taiko: {
    chainId: 167000,
    name: 'Taiko',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  unichain: {
    chainId: 130,
    name: 'Unichain',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  'world-chain': {
    chainId: 480,
    name: 'World Chain',
    type: 'evm',
    nativeSymbol: 'WLD',
    nativeName: 'Worldcoin',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  abstract: {
    chainId: 2741,
    name: 'Abstract',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  apechain: {
    chainId: 33139,
    name: 'ApeChain',
    type: 'evm',
    nativeSymbol: 'APE',
    nativeName: 'ApeCoin',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
};

/**
 * Non-EVM chains configuration
 * Chain IDs use numeric values to match database schema:
 * - Bitcoin: 0
 * - Tron: -1
 * - Solana: -2
 * - Bitcoin Cash: -3
 * - Litecoin: -4
 * - Cardano: -5
 * - (Other chains use negative IDs to avoid conflicts with EVM chains)
 */
export const NON_EVM_CHAINS: Record<string, ChainConfig> = {
  bitcoin: {
    chainId: 0,
    name: 'Bitcoin',
    type: 'bitcoin',
    nativeSymbol: 'BTC',
    nativeName: 'Bitcoin',
    defiLlamaId: 'bitcoin',
    coinGeckoPlatformId: 'bitcoin',
    isActive: true,
  },
  solana: {
    chainId: -2,
    name: 'Solana',
    type: 'solana',
    nativeSymbol: 'SOL',
    nativeName: 'Solana',
    defiLlamaId: 'solana',
    coinGeckoPlatformId: 'solana',
    isActive: true,
  },
  tron: {
    chainId: -1,
    name: 'Tron',
    type: 'tron',
    nativeSymbol: 'TRX',
    nativeName: 'Tron',
    defiLlamaId: 'tron',
    coinGeckoPlatformId: 'tron',
    isActive: true,
  },
  ton: {
    chainId: -15,
    name: 'TON',
    type: 'ton',
    nativeSymbol: 'TON',
    nativeName: 'Toncoin',
    defiLlamaId: 'ton',
    isActive: true,
  },
};

/**
 * Get all active chain configurations
 */
export function getAllChains(): ChainConfig[] {
  return [
    ...Object.values(EVM_CHAINS).filter((chain) => chain.isActive),
    ...Object.values(NON_EVM_CHAINS).filter((chain) => chain.isActive),
  ];
}

/**
 * Get chain configuration by chain ID
 * Handles both string and numeric chainIds (e.g., "1" matches 1, "bitcoin" matches "bitcoin")
 */
export function getChainConfig(chainId: string | number): ChainConfig | undefined {
  // Normalize chainId for comparison
  const normalizedChainId = typeof chainId === 'string' ? chainId : chainId.toString();

  // Check EVM chains (numeric chainIds stored as numbers in config)
  const evmChain = Object.values(EVM_CHAINS).find((chain) => {
    const configChainId =
      typeof chain.chainId === 'number' ? chain.chainId.toString() : chain.chainId;
    return configChainId === normalizedChainId;
  });
  if (evmChain) return evmChain;

  // Check non-EVM chains (string chainIds)
  return Object.values(NON_EVM_CHAINS).find((chain) => {
    const configChainId =
      typeof chain.chainId === 'number' ? chain.chainId.toString() : chain.chainId;
    return configChainId === normalizedChainId;
  });
}

/**
 * Get all EVM chain IDs
 */
export function getEvmChainIds(): number[] {
  return Object.values(EVM_CHAINS)
    .filter((chain) => chain.isActive)
    .map((chain) => chain.chainId as number);
}
