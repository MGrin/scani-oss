/**
 * Bitstamp Integration Factory
 *
 * Provides factory functions for creating and validating Bitstamp integrations
 * without exposing implementation details to consumers
 */

import { bitstampRateLimiter } from '../rate-limiters/bitstamp';
import { BitstampApiService } from '../services/BitstampApiService';

/**
 * Create a BitstampApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createBitstampApiService(): BitstampApiService {
  const baseUrl = process.env.BITSTAMP_API_BASE_URL || 'https://www.bitstamp.net/api/v2';
  return new BitstampApiService(baseUrl, bitstampRateLimiter);
}

/**
 * Validate Bitstamp API credentials
 *
 * @param apiKey - Bitstamp API Key
 * @param apiSecret - Bitstamp API Secret
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateBitstampCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  const service = createBitstampApiService();
  return await service.validateApiKey(apiKey, apiSecret);
}
