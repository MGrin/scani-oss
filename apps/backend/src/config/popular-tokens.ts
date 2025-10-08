/**
 * Popular Tokens Configuration
 *
 * Pre-curated list of popular ERC-20 tokens across multiple chains.
 * All tokens are validated to exist on CoinGecko for pricing support.
 *
 * Data structure matches CoinGecko's platform IDs and includes
 * contract addresses, decimals, and CoinGecko IDs for each token.
 */

export interface PopularToken {
  address: string; // Contract address (lowercase)
  symbol: string; // Token symbol (USDT, USDC, etc.)
  name: string; // Full token name
  decimals: number; // Token decimals
  chainId: number; // EVM chain ID
  coingeckoId: string; // CoinGecko coin ID (for pricing)
  coingeckoPlatform: string; // CoinGecko platform ID (ethereum, polygon-pos, etc.)
}

/**
 * Map EVM chain IDs to CoinGecko platform IDs
 */
export const CHAIN_ID_TO_COINGECKO_PLATFORM: Record<number, string> = {
  1: 'ethereum',
  56: 'binance-smart-chain',
  137: 'polygon-pos',
  42161: 'arbitrum-one',
  10: 'optimistic-ethereum',
  43114: 'avalanche',
  250: 'fantom',
  8453: 'base',
  324: 'zksync',
  59144: 'linea',
  534352: 'scroll',
  100: 'xdai', // Gnosis
  1284: 'moonbeam',
  1285: 'moonriver',
  25: 'cronos',
  288: 'boba',
  1088: 'metis-andromeda',
  42220: 'celo',
  1313161554: 'aurora',
};

/**
 * Popular tokens on Ethereum (Chain ID: 1)
 */
const ETHEREUM_TOKENS: PopularToken[] = [
  // Stablecoins
  {
    address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    chainId: 1,
    coingeckoId: 'tether',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    chainId: 1,
    coingeckoId: 'usd-coin',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0x6b175474e89094c44da98b954eedeac495271d0f',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'dai',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0x0000000000085d4780b73119b644ae5ecd22b376',
    symbol: 'TUSD',
    name: 'TrueUSD',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'true-usd',
    coingeckoPlatform: 'ethereum',
  },

  // Wrapped Assets
  {
    address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'weth',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    chainId: 1,
    coingeckoId: 'wrapped-bitcoin',
    coingeckoPlatform: 'ethereum',
  },

  // DeFi Blue Chips
  {
    address: '0x514910771af9ca656af840dff83e8264ecf986ca',
    symbol: 'LINK',
    name: 'Chainlink',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'chainlink',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'uniswap',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
    symbol: 'AAVE',
    name: 'Aave',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'aave',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2',
    symbol: 'MKR',
    name: 'Maker',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'maker',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0xc00e94cb662c3520282e6f5717214004a7f26888',
    symbol: 'COMP',
    name: 'Compound',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'compound-governance-token',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0xc944e90c64b2c07662a292be6244bdf05cda44a7',
    symbol: 'GRT',
    name: 'The Graph',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'the-graph',
    coingeckoPlatform: 'ethereum',
  },

  // Meme Tokens (High Trading Volume)
  {
    address: '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce',
    symbol: 'SHIB',
    name: 'Shiba Inu',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'shiba-inu',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
    symbol: 'PEPE',
    name: 'Pepe',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'pepe',
    coingeckoPlatform: 'ethereum',
  },

  // Exchange Tokens
  {
    address: '0x4d224452801aced8b2f0aebe155379bb5d594381',
    symbol: 'APE',
    name: 'ApeCoin',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'apecoin',
    coingeckoPlatform: 'ethereum',
  },

  // Layer 2 Tokens
  {
    address: '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2',
    symbol: 'SUSHI',
    name: 'SushiSwap',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'sushi',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b',
    symbol: 'CVX',
    name: 'Convex Finance',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'convex-finance',
    coingeckoPlatform: 'ethereum',
  },

  // Staking/Liquid Staking
  {
    address: '0x5a98fcbea516cf06857215779fd812ca3bef1b32',
    symbol: 'LDO',
    name: 'Lido DAO',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'lido-dao',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0xae78736cd615f374d3085123a210448e74fc6393',
    symbol: 'rETH',
    name: 'Rocket Pool ETH',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'rocket-pool-eth',
    coingeckoPlatform: 'ethereum',
  },
  {
    address: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
    symbol: 'stETH',
    name: 'Lido Staked Ether',
    decimals: 18,
    chainId: 1,
    coingeckoId: 'staked-ether',
    coingeckoPlatform: 'ethereum',
  },
];

/**
 * Popular tokens on Polygon (Chain ID: 137)
 */
const POLYGON_TOKENS: PopularToken[] = [
  // Stablecoins
  {
    address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    chainId: 137,
    coingeckoId: 'tether',
    coingeckoPlatform: 'polygon-pos',
  },
  {
    address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    chainId: 137,
    coingeckoId: 'usd-coin',
    coingeckoPlatform: 'polygon-pos',
  },
  {
    address: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    chainId: 137,
    coingeckoId: 'dai',
    coingeckoPlatform: 'polygon-pos',
  },

  // Wrapped Assets
  {
    address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
    symbol: 'WMATIC',
    name: 'Wrapped Matic',
    decimals: 18,
    chainId: 137,
    coingeckoId: 'wmatic',
    coingeckoPlatform: 'polygon-pos',
  },
  {
    address: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    chainId: 137,
    coingeckoId: 'weth',
    coingeckoPlatform: 'polygon-pos',
  },
  {
    address: '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6',
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    chainId: 137,
    coingeckoId: 'wrapped-bitcoin',
    coingeckoPlatform: 'polygon-pos',
  },

  // DeFi Tokens
  {
    address: '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39',
    symbol: 'LINK',
    name: 'Chainlink',
    decimals: 18,
    chainId: 137,
    coingeckoId: 'chainlink',
    coingeckoPlatform: 'polygon-pos',
  },
  {
    address: '0xb33eaad8d922b1083446dc23f610c2567fb5180f',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    chainId: 137,
    coingeckoId: 'uniswap',
    coingeckoPlatform: 'polygon-pos',
  },
  {
    address: '0xd6df932a45c0f255f85145f286ea0b292b21c90b',
    symbol: 'AAVE',
    name: 'Aave',
    decimals: 18,
    chainId: 137,
    coingeckoId: 'aave',
    coingeckoPlatform: 'polygon-pos',
  },
  {
    address: '0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a',
    symbol: 'SUSHI',
    name: 'SushiSwap',
    decimals: 18,
    chainId: 137,
    coingeckoId: 'sushi',
    coingeckoPlatform: 'polygon-pos',
  },
];

/**
 * Popular tokens on BSC (Chain ID: 56)
 */
const BSC_TOKENS: PopularToken[] = [
  // Stablecoins
  {
    address: '0x55d398326f99059ff775485246999027b3197955',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 18,
    chainId: 56,
    coingeckoId: 'tether',
    coingeckoPlatform: 'binance-smart-chain',
  },
  {
    address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 18,
    chainId: 56,
    coingeckoId: 'usd-coin',
    coingeckoPlatform: 'binance-smart-chain',
  },
  {
    address: '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    chainId: 56,
    coingeckoId: 'dai',
    coingeckoPlatform: 'binance-smart-chain',
  },

  // Wrapped Assets
  {
    address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    symbol: 'WBNB',
    name: 'Wrapped BNB',
    decimals: 18,
    chainId: 56,
    coingeckoId: 'wbnb',
    coingeckoPlatform: 'binance-smart-chain',
  },
  {
    address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    chainId: 56,
    coingeckoId: 'weth',
    coingeckoPlatform: 'binance-smart-chain',
  },
  {
    address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
    symbol: 'BTCB',
    name: 'Bitcoin BEP2',
    decimals: 18,
    chainId: 56,
    coingeckoId: 'binance-bitcoin',
    coingeckoPlatform: 'binance-smart-chain',
  },

  // Exchange Tokens
  {
    address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
    symbol: 'CAKE',
    name: 'PancakeSwap',
    decimals: 18,
    chainId: 56,
    coingeckoId: 'pancakeswap-token',
    coingeckoPlatform: 'binance-smart-chain',
  },

  // DeFi Tokens
  {
    address: '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd',
    symbol: 'LINK',
    name: 'Chainlink',
    decimals: 18,
    chainId: 56,
    coingeckoId: 'chainlink',
    coingeckoPlatform: 'binance-smart-chain',
  },
  {
    address: '0xbf5140a22578168fd562dccf235e5d43a02ce9b1',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    chainId: 56,
    coingeckoId: 'uniswap',
    coingeckoPlatform: 'binance-smart-chain',
  },
  {
    address: '0xfb6115445bff7b52feb98650c87f44907e58f802',
    symbol: 'AAVE',
    name: 'Aave',
    decimals: 18,
    chainId: 56,
    coingeckoId: 'aave',
    coingeckoPlatform: 'binance-smart-chain',
  },
];

/**
 * Popular tokens on Arbitrum (Chain ID: 42161)
 */
const ARBITRUM_TOKENS: PopularToken[] = [
  // Stablecoins
  {
    address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    chainId: 42161,
    coingeckoId: 'tether',
    coingeckoPlatform: 'arbitrum-one',
  },
  {
    address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    chainId: 42161,
    coingeckoId: 'usd-coin',
    coingeckoPlatform: 'arbitrum-one',
  },
  {
    address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    chainId: 42161,
    coingeckoId: 'dai',
    coingeckoPlatform: 'arbitrum-one',
  },

  // Wrapped Assets
  {
    address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    chainId: 42161,
    coingeckoId: 'weth',
    coingeckoPlatform: 'arbitrum-one',
  },
  {
    address: '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f',
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    chainId: 42161,
    coingeckoId: 'wrapped-bitcoin',
    coingeckoPlatform: 'arbitrum-one',
  },

  // Native Token
  {
    address: '0x912ce59144191c1204e64559fe8253a0e49e6548',
    symbol: 'ARB',
    name: 'Arbitrum',
    decimals: 18,
    chainId: 42161,
    coingeckoId: 'arbitrum',
    coingeckoPlatform: 'arbitrum-one',
  },

  // DeFi Tokens
  {
    address: '0xf97f4df75117a78c1a5a0dbb814af92458539fb4',
    symbol: 'LINK',
    name: 'Chainlink',
    decimals: 18,
    chainId: 42161,
    coingeckoId: 'chainlink',
    coingeckoPlatform: 'arbitrum-one',
  },
  {
    address: '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    chainId: 42161,
    coingeckoId: 'uniswap',
    coingeckoPlatform: 'arbitrum-one',
  },
];

/**
 * Popular tokens on Base (Chain ID: 8453)
 */
const BASE_TOKENS: PopularToken[] = [
  // Stablecoins
  {
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    chainId: 8453,
    coingeckoId: 'usd-coin',
    coingeckoPlatform: 'base',
  },
  {
    address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    chainId: 8453,
    coingeckoId: 'dai',
    coingeckoPlatform: 'base',
  },

  // Wrapped Assets
  {
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    chainId: 8453,
    coingeckoId: 'weth',
    coingeckoPlatform: 'base',
  },
];

/**
 * All popular tokens combined
 */
export const POPULAR_TOKENS: PopularToken[] = [
  ...ETHEREUM_TOKENS,
  ...POLYGON_TOKENS,
  ...BSC_TOKENS,
  ...ARBITRUM_TOKENS,
  ...BASE_TOKENS,
];

/**
 * Get popular tokens for a specific chain
 */
export function getPopularTokensForChain(chainId: number): PopularToken[] {
  return POPULAR_TOKENS.filter((token) => token.chainId === chainId);
}

/**
 * Get CoinGecko platform ID for a chain ID
 */
export function getCoinGeckoPlatform(chainId: number): string | null {
  return CHAIN_ID_TO_COINGECKO_PLATFORM[chainId] || null;
}

/**
 * Find a token by address and chain ID
 */
export function findTokenByAddress(address: string, chainId: number): PopularToken | undefined {
  const normalizedAddress = address.toLowerCase();
  return POPULAR_TOKENS.find(
    (token) => token.address === normalizedAddress && token.chainId === chainId
  );
}

/**
 * Get all unique CoinGecko IDs (for batch price fetching)
 */
export function getAllCoinGeckoIds(): string[] {
  return Array.from(new Set(POPULAR_TOKENS.map((token) => token.coingeckoId)));
}
