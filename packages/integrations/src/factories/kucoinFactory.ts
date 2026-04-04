/**
 * KuCoin Integration Factory
 *
 * Provides factory functions for creating and validating KuCoin integrations
 * without exposing implementation details to consumers
 */

import { kucoinRateLimiter } from '../rate-limiters/kucoin';
import { KucoinApiService } from '../services/KucoinApiService';

/**
 * Create a KucoinApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createKucoinApiService(): KucoinApiService {
  const baseUrl = process.env.KUCOIN_API_BASE_URL || 'https://api.kucoin.com';
  return new KucoinApiService(baseUrl, kucoinRateLimiter);
}

/**
 * Validate KuCoin API credentials
 *
 * @param apiKey - KuCoin API Key
 * @param apiSecret - KuCoin API Secret
 * @param passphrase - KuCoin API Passphrase
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateKucoinCredentials(
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<boolean> {
  const service = createKucoinApiService();
  return await service.validateApiKey(apiKey, apiSecret, passphrase);
}
