// Environment variables for API keys
export const config = {
  alphaVantage: {
    apiKey: process.env.ALPHA_VANTAGE_API_KEY || '',
    baseUrl: 'https://www.alphavantage.co/query',
  },
  coinGecko: {
    apiKey: process.env.COINGECKO_API_KEY || '', // Optional, can work without
    baseUrl: 'https://api.coingecko.com/api/v3',
  },
  exchangeRate: {
    baseUrl: 'https://api.exchangerate-api.com/v4',
  },
} as const;
