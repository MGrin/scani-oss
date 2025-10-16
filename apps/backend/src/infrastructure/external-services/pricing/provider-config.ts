export const PROVIDER_CONFIGS = {
  exchangeRate: {
    name: 'ExchangeRate-API',
    baseUrl: 'https://api.exchangerate-api.com/v4/latest',
    rateLimit: 1500,
  },
  coinGecko: {
    name: 'CoinGecko',
    baseUrl: 'https://api.coingecko.com/api/v3',
    rateLimit: 50,
  },
  defiLlama: {
    name: 'DeFiLlama',
    baseUrl: 'https://coins.llama.fi',
    rateLimit: 300, // 5 calls/sec = 300 calls/min
  },
  finnhub: {
    name: 'Finnhub',
    baseUrl: 'https://finnhub.io/api/v1',
    rateLimit: 60,
  },
  googleSheets: {
    name: 'Google Sheets (GOOGLEFINANCE)',
    rateLimit: 100,
  },
} as const;
