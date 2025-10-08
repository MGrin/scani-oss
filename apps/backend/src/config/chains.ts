/**
 * Blockchain Chain Configurations
 *
 * Defines RPC endpoints, chain IDs, and metadata for all supported blockchain networks.
 * Based on Etherscan supported chains: https://docs.etherscan.io/supported-chains
 */

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrls: string[]; // Multiple RPCs for fallback
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  blockExplorerUrls?: string[];
  isTestnet: boolean;
}

/**
 * EVM Chain Configurations
 * All mainnet EVM chains supported by Etherscan
 */
export const EVM_CHAINS: Record<number, ChainConfig> = {
  // Ethereum Mainnet
  1: {
    chainId: 1,
    name: 'Ethereum',
    rpcUrls: [
      'https://eth.llamarpc.com',
      'https://rpc.ankr.com/eth',
      'https://ethereum.publicnode.com',
    ],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://etherscan.io'],
    isTestnet: false,
  },

  // Arbitrum One
  42161: {
    chainId: 42161,
    name: 'Arbitrum',
    rpcUrls: [
      'https://arb1.arbitrum.io/rpc',
      'https://rpc.ankr.com/arbitrum',
      'https://arbitrum.llamarpc.com',
    ],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://arbiscan.io'],
    isTestnet: false,
  },

  // Arbitrum Nova
  42170: {
    chainId: 42170,
    name: 'Arbitrum Nova',
    rpcUrls: ['https://nova.arbitrum.io/rpc'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://nova.arbiscan.io'],
    isTestnet: false,
  },

  // Avalanche C-Chain
  43114: {
    chainId: 43114,
    name: 'Avalanche',
    rpcUrls: [
      'https://api.avax.network/ext/bc/C/rpc',
      'https://rpc.ankr.com/avalanche',
      'https://avalanche.public-rpc.com',
    ],
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    blockExplorerUrls: ['https://snowtrace.io'],
    isTestnet: false,
  },

  // Base
  8453: {
    chainId: 8453,
    name: 'Base',
    rpcUrls: [
      'https://mainnet.base.org',
      'https://base.llamarpc.com',
      'https://base.publicnode.com',
    ],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://basescan.org'],
    isTestnet: false,
  },

  // Berachain
  80094: {
    chainId: 80094,
    name: 'Berachain',
    rpcUrls: ['https://rpc.berachain.com'],
    nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
    blockExplorerUrls: ['https://bartio.beratrail.io'],
    isTestnet: false,
  },

  // BitTorrent Chain
  199: {
    chainId: 199,
    name: 'BitTorrent Chain',
    rpcUrls: ['https://rpc.bittorrentchain.io'],
    nativeCurrency: { name: 'BitTorrent', symbol: 'BTT', decimals: 18 },
    blockExplorerUrls: ['https://bttcscan.com'],
    isTestnet: false,
  },

  // Blast
  81457: {
    chainId: 81457,
    name: 'Blast',
    rpcUrls: ['https://rpc.blast.io', 'https://blast.din.dev/rpc'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://blastscan.io'],
    isTestnet: false,
  },

  // BNB Smart Chain
  56: {
    chainId: 56,
    name: 'Binance Smart Chain',
    rpcUrls: [
      'https://bsc-dataseed.binance.org',
      'https://rpc.ankr.com/bsc',
      'https://bsc.publicnode.com',
    ],
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    blockExplorerUrls: ['https://bscscan.com'],
    isTestnet: false,
  },

  // Celo
  42220: {
    chainId: 42220,
    name: 'Celo',
    rpcUrls: ['https://forno.celo.org', 'https://rpc.ankr.com/celo'],
    nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
    blockExplorerUrls: ['https://celoscan.io'],
    isTestnet: false,
  },

  // Cronos
  25: {
    chainId: 25,
    name: 'Cronos',
    rpcUrls: ['https://evm.cronos.org', 'https://cronos.blockpi.network/v1/rpc/public'],
    nativeCurrency: { name: 'Cronos', symbol: 'CRO', decimals: 18 },
    blockExplorerUrls: ['https://cronoscan.com'],
    isTestnet: false,
  },

  // Fraxtal
  252: {
    chainId: 252,
    name: 'Fraxtal',
    rpcUrls: ['https://rpc.frax.com'],
    nativeCurrency: { name: 'Frax Ether', symbol: 'frxETH', decimals: 18 },
    blockExplorerUrls: ['https://fraxscan.com'],
    isTestnet: false,
  },

  // Gnosis
  100: {
    chainId: 100,
    name: 'Gnosis',
    rpcUrls: ['https://rpc.gnosischain.com', 'https://gnosis.publicnode.com'],
    nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
    blockExplorerUrls: ['https://gnosisscan.io'],
    isTestnet: false,
  },

  // HyperEVM
  999: {
    chainId: 999,
    name: 'HyperEVM',
    rpcUrls: ['https://rpc.hyperevm.com'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },

  // Linea
  59144: {
    chainId: 59144,
    name: 'Linea',
    rpcUrls: ['https://rpc.linea.build', 'https://linea.blockpi.network/v1/rpc/public'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://lineascan.build'],
    isTestnet: false,
  },

  // Mantle
  5000: {
    chainId: 5000,
    name: 'Mantle',
    rpcUrls: ['https://rpc.mantle.xyz', 'https://mantle.publicnode.com'],
    nativeCurrency: { name: 'MNT', symbol: 'MNT', decimals: 18 },
    blockExplorerUrls: ['https://explorer.mantle.xyz'],
    isTestnet: false,
  },

  // Moonbeam
  1284: {
    chainId: 1284,
    name: 'Moonbeam',
    rpcUrls: ['https://rpc.api.moonbeam.network', 'https://moonbeam.publicnode.com'],
    nativeCurrency: { name: 'Glimmer', symbol: 'GLMR', decimals: 18 },
    blockExplorerUrls: ['https://moonscan.io'],
    isTestnet: false,
  },

  // Moonriver
  1285: {
    chainId: 1285,
    name: 'Moonriver',
    rpcUrls: ['https://rpc.api.moonriver.moonbeam.network'],
    nativeCurrency: { name: 'Moonriver', symbol: 'MOVR', decimals: 18 },
    blockExplorerUrls: ['https://moonriver.moonscan.io'],
    isTestnet: false,
  },

  // Optimism
  10: {
    chainId: 10,
    name: 'Optimism',
    rpcUrls: [
      'https://mainnet.optimism.io',
      'https://rpc.ankr.com/optimism',
      'https://optimism.llamarpc.com',
    ],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://optimistic.etherscan.io'],
    isTestnet: false,
  },

  // Polygon
  137: {
    chainId: 137,
    name: 'Polygon',
    rpcUrls: [
      'https://polygon-rpc.com',
      'https://rpc.ankr.com/polygon',
      'https://polygon.llamarpc.com',
    ],
    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
    blockExplorerUrls: ['https://polygonscan.com'],
    isTestnet: false,
  },

  // Ronin (Katana)
  747474: {
    chainId: 747474,
    name: 'Ronin',
    rpcUrls: ['https://api.roninchain.com/rpc'],
    nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
    blockExplorerUrls: ['https://app.roninchain.com'],
    isTestnet: false,
  },

  // Scroll
  534352: {
    chainId: 534352,
    name: 'Scroll',
    rpcUrls: ['https://rpc.scroll.io', 'https://scroll.blockpi.network/v1/rpc/public'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://scrollscan.com'],
    isTestnet: false,
  },

  // Sei
  1329: {
    chainId: 1329,
    name: 'Sei',
    rpcUrls: ['https://evm-rpc.sei-apis.com'],
    nativeCurrency: { name: 'SEI', symbol: 'SEI', decimals: 18 },
    blockExplorerUrls: ['https://seitrace.com'],
    isTestnet: false,
  },

  // Sonic
  146: {
    chainId: 146,
    name: 'Sonic',
    rpcUrls: ['https://rpc.soniclabs.com'],
    nativeCurrency: { name: 'Sonic', symbol: 'S', decimals: 18 },
    isTestnet: false,
  },

  // Sophon
  50104: {
    chainId: 50104,
    name: 'Sophon',
    rpcUrls: ['https://rpc.sophon.xyz'],
    nativeCurrency: { name: 'SOPH', symbol: 'SOPH', decimals: 18 },
    isTestnet: false,
  },

  // Swellchain
  1923: {
    chainId: 1923,
    name: 'Swellchain',
    rpcUrls: ['https://rpc.swellnetwork.io'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },

  // Taiko
  167000: {
    chainId: 167000,
    name: 'Taiko',
    rpcUrls: ['https://rpc.taiko.xyz', 'https://taiko.blockpi.network/v1/rpc/public'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://taikoscan.io'],
    isTestnet: false,
  },

  // Unichain
  130: {
    chainId: 130,
    name: 'Unichain',
    rpcUrls: ['https://rpc.unichain.org'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },

  // World Chain
  480: {
    chainId: 480,
    name: 'World Chain',
    rpcUrls: ['https://worldchain-mainnet.g.alchemy.com/public'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://worldscan.org'],
    isTestnet: false,
  },

  // XDC Network
  50: {
    chainId: 50,
    name: 'XDC Network',
    rpcUrls: ['https://rpc.xdcrpc.com', 'https://erpc.xinfin.network'],
    nativeCurrency: { name: 'XDC', symbol: 'XDC', decimals: 18 },
    blockExplorerUrls: ['https://explorer.xinfin.network'],
    isTestnet: false,
  },

  // zkSync Era
  324: {
    chainId: 324,
    name: 'zkSync Era',
    rpcUrls: ['https://mainnet.era.zksync.io', 'https://zksync.meowrpc.com'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://explorer.zksync.io'],
    isTestnet: false,
  },

  // opBNB
  204: {
    chainId: 204,
    name: 'opBNB',
    rpcUrls: ['https://opbnb-mainnet-rpc.bnbchain.org', 'https://opbnb.publicnode.com'],
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    blockExplorerUrls: ['https://opbnbscan.com'],
    isTestnet: false,
  },

  // Fantom
  250: {
    chainId: 250,
    name: 'Fantom',
    rpcUrls: ['https://rpc.ftm.tools', 'https://rpc.ankr.com/fantom'],
    nativeCurrency: { name: 'Fantom', symbol: 'FTM', decimals: 18 },
    blockExplorerUrls: ['https://ftmscan.com'],
    isTestnet: false,
  },

  // Abstract
  2741: {
    chainId: 2741,
    name: 'Abstract',
    rpcUrls: ['https://rpc.abstract.xyz'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },

  // ApeChain
  33139: {
    chainId: 33139,
    name: 'ApeChain',
    rpcUrls: ['https://rpc.apechain.com'],
    nativeCurrency: { name: 'APE', symbol: 'APE', decimals: 18 },
    isTestnet: false,
  },
};

/**
 * Get all supported EVM chain IDs
 */
export function getSupportedEVMChainIds(): number[] {
  return Object.keys(EVM_CHAINS).map(Number);
}

/**
 * Check if a chain ID is supported
 */
export function isEVMChainSupported(chainId: number): boolean {
  return chainId in EVM_CHAINS;
}

/**
 * Get chain configuration by chain ID
 */
export function getChainConfig(chainId: number): ChainConfig | undefined {
  return EVM_CHAINS[chainId];
}

/**
 * Detect if an address is an EVM address (starts with 0x and is 42 characters)
 */
export function isEVMAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
