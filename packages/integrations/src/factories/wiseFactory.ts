/**
 * Wise Integration Factory
 *
 * Provides factory functions for creating and validating Wise integrations
 * without exposing implementation details to consumers
 */

import { wiseRateLimiter } from '../rate-limiters/wise';
import { WiseApiService } from '../services/WiseApiService';

/**
 * Create a WiseApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createWiseApiService(): WiseApiService {
  const baseUrl = process.env.WISE_API_BASE_URL || 'https://api.wise.com';
  return new WiseApiService(baseUrl, wiseRateLimiter);
}

/**
 * Validate Wise API token
 *
 * @param apiToken - Wise API Token (Bearer token)
 * @returns Promise<boolean> - true if token is valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateWiseCredentials(apiToken: string): Promise<boolean> {
  const service = createWiseApiService();
  return await service.validateApiToken(apiToken);
}
