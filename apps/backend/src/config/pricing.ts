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
} as const;
