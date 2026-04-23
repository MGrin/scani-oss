import { coincheckRateLimiter } from '../rate-limiters/coincheck';
import { CoincheckApiService } from '../services/CoincheckApiService';

export function createCoincheckApiService(): CoincheckApiService {
  const baseUrl = process.env.COINCHECK_API_BASE_URL || 'https://coincheck.com';
  return new CoincheckApiService(baseUrl, coincheckRateLimiter);
}

export async function validateCoincheckCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  return await createCoincheckApiService().validateApiKey(apiKey, apiSecret);
}
