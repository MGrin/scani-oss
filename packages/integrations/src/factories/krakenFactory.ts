/**
 * Kraken Integration Factory
 *
 * Provides factory functions for creating and validating Kraken integrations
 * without exposing implementation details to consumers
 */

import { krakenRateLimiter } from '../rate-limiters/kraken';
import { KrakenApiService } from '../services/KrakenApiService';

/**
 * Create a KrakenApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createKrakenApiService(): KrakenApiService {
  const baseUrl = process.env.KRAKEN_API_BASE_URL || 'https://api.kraken.com';
  return new KrakenApiService(baseUrl, krakenRateLimiter);
}

/**
 * Validate Kraken API credentials
 *
 * @param apiKey - Kraken API Key
 * @param apiSecret - Kraken API Secret (base64 encoded)
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateKrakenCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  const service = createKrakenApiService();
  return await service.validateApiKey(apiKey, apiSecret);
}
