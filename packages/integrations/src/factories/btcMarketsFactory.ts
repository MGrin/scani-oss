import { btcMarketsRateLimiter } from '../rate-limiters/btcMarkets';
import { BtcMarketsApiService } from '../services/BtcMarketsApiService';

export function createBtcMarketsApiService(): BtcMarketsApiService {
  const baseUrl = process.env.BTC_MARKETS_API_BASE_URL || 'https://api.btcmarkets.net';
  return new BtcMarketsApiService(baseUrl, btcMarketsRateLimiter);
}

export async function validateBtcMarketsCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  return await createBtcMarketsApiService().validateApiKey(apiKey, apiSecret);
}
