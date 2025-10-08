// Environment variables for API keys
export const config = {
  finnhub: {
    apiKey: process.env.FINNHUB_API_KEY || '',
    baseUrl: 'https://finnhub.io/api/v1',
  },
  coinGecko: {
    apiKey: process.env.COINGECKO_API_KEY || '',
    baseUrl: process.env.COINGECKO_API_KEY
      ? 'https://pro-api.coingecko.com/api/v3' // Pro API if key available
      : 'https://api.coingecko.com/api/v3', // Free API otherwise
  },
  exchangeRate: {
    baseUrl: 'https://api.exchangerate-api.com/v4',
  },
  etherscan: {
    // Etherscan API keys for different chains (you can use same key for all)
    ethereum: process.env.ETHERSCAN_API_KEY || '',
    polygon: process.env.POLYGONSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
    bsc: process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
    arbitrum: process.env.ARBISCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
    optimism: process.env.OPTIMISTIC_ETHERSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
    base: process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
    avalanche: process.env.SNOWTRACE_API_KEY || process.env.ETHERSCAN_API_KEY || '',
    // Fallback for other chains
    default: process.env.ETHERSCAN_API_KEY || '',
  },
} as const;
