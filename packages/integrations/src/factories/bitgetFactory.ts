/**
 * Bitget Integration Factory
 *
 * Provides factory functions for creating and validating Bitget integrations
 * without exposing implementation details to consumers
 *
 * Note: Bitget requires a passphrase in addition to apiKey and apiSecret
 */

import { bitgetRateLimiter } from '../rate-limiters/bitget';
import { BitgetApiService } from '../services/BitgetApiService';

/**
 * Create a BitgetApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createBitgetApiService(): BitgetApiService {
  const baseUrl = process.env.BITGET_API_BASE_URL || 'https://api.bitget.com';
  return new BitgetApiService(baseUrl, bitgetRateLimiter);
}

/**
 * Validate Bitget API credentials
 *
 * @param apiKey - Bitget API Key
 * @param apiSecret - Bitget API Secret
 * @param passphrase - Bitget API Passphrase
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateBitgetCredentials(
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<boolean> {
  const service = createBitgetApiService();
  return await service.validateApiKey(apiKey, apiSecret, passphrase);
}
