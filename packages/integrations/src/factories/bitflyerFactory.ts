import { bitflyerRateLimiter } from '../rate-limiters/bitflyer';
import { BitflyerApiService } from '../services/BitflyerApiService';

export function createBitflyerApiService(): BitflyerApiService {
  const baseUrl = process.env.BITFLYER_API_BASE_URL || 'https://api.bitflyer.com';
  return new BitflyerApiService(baseUrl, bitflyerRateLimiter);
}

export async function validateBitflyerCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  return await createBitflyerApiService().validateApiKey(apiKey, apiSecret);
}
