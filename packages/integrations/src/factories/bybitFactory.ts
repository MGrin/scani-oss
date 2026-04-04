/**
 * Bybit Integration Factory
 *
 * Provides factory functions for creating and validating Bybit integrations
 * without exposing implementation details to consumers
 */

import { bybitRateLimiter } from '../rate-limiters/bybit';
import { BybitApiService } from '../services/BybitApiService';

/**
 * Create a BybitApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createBybitApiService(): BybitApiService {
  const baseUrl = process.env.BYBIT_API_BASE_URL || 'https://api.bybit.com';
  return new BybitApiService(baseUrl, bybitRateLimiter);
}

/**
 * Validate Bybit API credentials
 *
 * @param apiKey - Bybit API Key
 * @param apiSecret - Bybit API Secret
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateBybitCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  const service = createBybitApiService();
  return await service.validateApiKey(apiKey, apiSecret);
}
