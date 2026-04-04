/**
 * Coinbase Integration Factory
 *
 * Provides factory functions for creating and validating Coinbase integrations
 * without exposing implementation details to consumers
 */

import { coinbaseRateLimiter } from '../rate-limiters/coinbase';
import { CoinbaseApiService } from '../services/CoinbaseApiService';

/**
 * Create a CoinbaseApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createCoinbaseApiService(): CoinbaseApiService {
  const baseUrl = process.env.COINBASE_API_BASE_URL || 'https://api.coinbase.com';
  return new CoinbaseApiService(baseUrl, coinbaseRateLimiter);
}

/**
 * Validate Coinbase API credentials
 *
 * @param apiKey - Coinbase API Key
 * @param apiSecret - Coinbase API Secret
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateCoinbaseCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  const service = createCoinbaseApiService();
  return await service.validateApiKey(apiKey, apiSecret);
}
