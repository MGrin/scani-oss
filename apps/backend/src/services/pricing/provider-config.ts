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
