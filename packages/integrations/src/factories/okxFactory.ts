/**
 * OKX Integration Factory
 *
 * Provides factory functions for creating and validating OKX integrations
 * without exposing implementation details to consumers
 *
 * Note: OKX requires a passphrase in addition to apiKey and apiSecret
 */

import { okxRateLimiter } from '../rate-limiters/okx';
import { OkxApiService } from '../services/OkxApiService';

/**
 * Create an OkxApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createOkxApiService(): OkxApiService {
  const baseUrl = process.env.OKX_API_BASE_URL || 'https://www.okx.com';
  return new OkxApiService(baseUrl, okxRateLimiter);
}

/**
 * Validate OKX API credentials
 *
 * @param apiKey - OKX API Key
 * @param apiSecret - OKX API Secret
 * @param passphrase - OKX API Passphrase
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateOkxCredentials(
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<boolean> {
  const service = createOkxApiService();
  return await service.validateApiKey(apiKey, apiSecret, passphrase);
}
