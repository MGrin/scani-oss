import { bitfinexRateLimiter } from '../rate-limiters/bitfinex';
import { BitfinexApiService } from '../services/BitfinexApiService';

export function createBitfinexApiService(): BitfinexApiService {
  const baseUrl = process.env.BITFINEX_API_BASE_URL || 'https://api.bitfinex.com';
  return new BitfinexApiService(baseUrl, bitfinexRateLimiter);
}

export async function validateBitfinexCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  return await createBitfinexApiService().validateApiKey(apiKey, apiSecret);
}
