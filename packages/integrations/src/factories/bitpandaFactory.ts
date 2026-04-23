import { bitpandaRateLimiter } from '../rate-limiters/bitpanda';
import { BitpandaApiService } from '../services/BitpandaApiService';

export function createBitpandaApiService(): BitpandaApiService {
  const baseUrl = process.env.BITPANDA_API_BASE_URL || 'https://api.bitpanda.com';
  return new BitpandaApiService(baseUrl, bitpandaRateLimiter);
}

export async function validateBitpandaCredentials(apiToken: string): Promise<boolean> {
  return await createBitpandaApiService().validateApiKey(apiToken);
}
