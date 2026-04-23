import { bitbankRateLimiter } from '../rate-limiters/bitbank';
import { BitbankApiService } from '../services/BitbankApiService';

export function createBitbankApiService(): BitbankApiService {
  const baseUrl = process.env.BITBANK_API_BASE_URL || 'https://api.bitbank.cc';
  return new BitbankApiService(baseUrl, bitbankRateLimiter);
}

export async function validateBitbankCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  return await createBitbankApiService().validateApiKey(apiKey, apiSecret);
}
