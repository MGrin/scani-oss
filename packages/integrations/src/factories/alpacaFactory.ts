import { alpacaRateLimiter } from '../rate-limiters/alpaca';
import { AlpacaApiService } from '../services/AlpacaApiService';

export function createAlpacaApiService(): AlpacaApiService {
  const baseUrl = process.env.ALPACA_API_BASE_URL || 'https://api.alpaca.markets';
  return new AlpacaApiService(baseUrl, alpacaRateLimiter);
}

export async function validateAlpacaCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  return await createAlpacaApiService().validateApiKey(apiKey, apiSecret);
}
