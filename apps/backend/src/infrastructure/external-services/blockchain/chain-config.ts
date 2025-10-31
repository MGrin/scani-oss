/**
 * Configuration for all supported blockchain chains
 * Based on Etherscan V2 API supported chains: https://docs.etherscan.io/supported-chains
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
  /** Etherscan API base URL (for EVM chains) */
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
 */
export const EVM_CHAINS: Record<string, ChainConfig> = {
  // Tier 1 - Major chains
  ethereum: {
    chainId: 1,
    name: 'Ethereum',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/api',
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
    explorerApiUrl: 'https://api.bscscan.com/api',
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
    explorerApiUrl: 'https://api.polygonscan.com/api',
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
    explorerApiUrl: 'https://api.snowtrace.io/api',
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
    explorerApiUrl: 'https://api.arbiscan.io/api',
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
    explorerApiUrl: 'https://api-optimistic.etherscan.io/api',
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
    explorerApiUrl: 'https://api.basescan.org/api',
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
    explorerApiUrl: 'https://api.ftmscan.com/api',
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
    explorerApiUrl: 'https://api.cronoscan.com/api',
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
    explorerApiUrl: 'https://api-nova.arbiscan.io/api',
    defiLlamaId: 'arbitrum_nova',
    isActive: true,
  },
  'zksync-era': {
    chainId: 324,
    name: 'zkSync Era',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api-era.zksync.network/api',
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
    explorerApiUrl: 'https://api.scrollscan.com/api',
    defiLlamaId: 'scroll',
    isActive: true,
  },
  linea: {
    chainId: 59144,
    name: 'Linea',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.lineascan.build/api',
    defiLlamaId: 'linea',
    isActive: true,
  },
  blast: {
    chainId: 81457,
    name: 'Blast',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.blastscan.io/api',
    defiLlamaId: 'blast',
    isActive: true,
  },
  mantle: {
    chainId: 5000,
    name: 'Mantle',
    type: 'evm',
    nativeSymbol: 'MNT',
    nativeName: 'Mantle',
    explorerApiUrl: 'https://api.mantlescan.xyz/api',
    defiLlamaId: 'mantle',
    isActive: true,
  },
  opbnb: {
    chainId: 204,
    name: 'opBNB',
    type: 'evm',
    nativeSymbol: 'BNB',
    nativeName: 'Binance Coin',
    explorerApiUrl: 'https://api-opbnb.bscscan.com/api',
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
    explorerApiUrl: 'https://api.gnosisscan.io/api',
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
    explorerApiUrl: 'https://api.celoscan.io/api',
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
    explorerApiUrl: 'https://api-moonbeam.moonscan.io/api',
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
    explorerApiUrl: 'https://api-moonriver.moonscan.io/api',
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
    explorerApiUrl: 'https://api.fraxscan.com/api',
    defiLlamaId: 'fraxtal',
    isActive: true,
  },
  ronin: {
    chainId: 747474,
    name: 'Ronin',
    type: 'evm',
    nativeSymbol: 'RON',
    nativeName: 'Ronin',
    explorerApiUrl: 'https://api.roninchain.com/api',
    defiLlamaId: 'ronin',
    isActive: true,
  },
  xdc: {
    chainId: 50,
    name: 'XDC Network',
    type: 'evm',
    nativeSymbol: 'XDC',
    nativeName: 'XDC',
    explorerApiUrl: 'https://api.xdcscan.io/api',
    isActive: true,
  },
  bittorrent: {
    chainId: 199,
    name: 'BitTorrent Chain',
    type: 'evm',
    nativeSymbol: 'BTT',
    nativeName: 'BitTorrent',
    explorerApiUrl: 'https://api.bttcscan.com/api',
    isActive: true,
  },

  // Newer chains (2024-2025)
  berachain: {
    chainId: 80094,
    name: 'Berachain',
    type: 'evm',
    nativeSymbol: 'BERA',
    nativeName: 'Berachain',
    explorerApiUrl: 'https://api.beratrail.io/api',
    isActive: true,
  },
  sei: {
    chainId: 1329,
    name: 'Sei',
    type: 'evm',
    nativeSymbol: 'SEI',
    nativeName: 'Sei',
    explorerApiUrl: 'https://api.seitrace.com/api',
    isActive: true,
  },
  sonic: {
    chainId: 146,
    name: 'Sonic',
    type: 'evm',
    nativeSymbol: 'S',
    nativeName: 'Sonic',
    isActive: true,
  },
  sophon: {
    chainId: 50104,
    name: 'Sophon',
    type: 'evm',
    nativeSymbol: 'SOPH',
    nativeName: 'Sophon',
    isActive: true,
  },
  swellchain: {
    chainId: 1923,
    name: 'Swellchain',
    type: 'evm',
    nativeSymbol: 'swETH',
    nativeName: 'Swell Ether',
    isActive: true,
  },
  taiko: {
    chainId: 167000,
    name: 'Taiko',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.taikoscan.io/api',
    isActive: true,
  },
  unichain: {
    chainId: 130,
    name: 'Unichain',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  'world-chain': {
    chainId: 480,
    name: 'World Chain',
    type: 'evm',
    nativeSymbol: 'WLD',
    nativeName: 'Worldcoin',
    isActive: true,
  },
  abstract: {
    chainId: 2741,
    name: 'Abstract',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  apechain: {
    chainId: 33139,
    name: 'ApeChain',
    type: 'evm',
    nativeSymbol: 'APE',
    nativeName: 'ApeCoin',
    isActive: true,
  },
};

/**
 * Non-EVM chains configuration
 */
export const NON_EVM_CHAINS: Record<string, ChainConfig> = {
  bitcoin: {
    chainId: 'bitcoin',
    name: 'Bitcoin',
    type: 'bitcoin',
    nativeSymbol: 'BTC',
    nativeName: 'Bitcoin',
    defiLlamaId: 'bitcoin',
    coinGeckoPlatformId: 'bitcoin',
    isActive: true,
  },
  solana: {
    chainId: 'solana',
    name: 'Solana',
    type: 'solana',
    nativeSymbol: 'SOL',
    nativeName: 'Solana',
    defiLlamaId: 'solana',
    coinGeckoPlatformId: 'solana',
    isActive: true,
  },
  tron: {
    chainId: 'tron',
    name: 'Tron',
    type: 'tron',
    nativeSymbol: 'TRX',
    nativeName: 'Tron',
    defiLlamaId: 'tron',
    coinGeckoPlatformId: 'tron',
    isActive: true,
  },
  ton: {
    chainId: 'ton',
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
 */
export function getChainConfig(chainId: string | number): ChainConfig | undefined {
  // Check EVM chains
  const evmChain = Object.values(EVM_CHAINS).find((chain) => chain.chainId === chainId);
  if (evmChain) return evmChain;

  // Check non-EVM chains
  return Object.values(NON_EVM_CHAINS).find((chain) => chain.chainId === chainId);
}

/**
 * Get all EVM chain IDs
 */
export function getEvmChainIds(): number[] {
  return Object.values(EVM_CHAINS)
    .filter((chain) => chain.isActive)
    .map((chain) => chain.chainId as number);
}
