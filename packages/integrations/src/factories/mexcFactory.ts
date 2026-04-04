/**
 * MEXC Integration Factory
 *
 * Provides factory functions for creating and validating MEXC integrations
 * without exposing implementation details to consumers
 */

import { mexcRateLimiter } from '../rate-limiters/mexc';
import { MexcApiService } from '../services/MexcApiService';

/**
 * Create a MexcApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createMexcApiService(): MexcApiService {
  const baseUrl = process.env.MEXC_API_BASE_URL || 'https://api.mexc.com';
  return new MexcApiService(baseUrl, mexcRateLimiter);
}

/**
 * Validate MEXC API credentials
 *
 * @param apiKey - MEXC API Key
 * @param apiSecret - MEXC API Secret
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateMexcCredentials(apiKey: string, apiSecret: string): Promise<boolean> {
  const service = createMexcApiService();
  return await service.validateApiKey(apiKey, apiSecret);
}
