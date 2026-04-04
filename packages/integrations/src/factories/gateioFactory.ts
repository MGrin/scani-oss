/**
 * Gate.io Integration Factory
 *
 * Provides factory functions for creating and validating Gate.io integrations
 * without exposing implementation details to consumers
 */

import { gateioRateLimiter } from '../rate-limiters/gateio';
import { GateioApiService } from '../services/GateioApiService';

/**
 * Create a GateioApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createGateioApiService(): GateioApiService {
  const baseUrl = process.env.GATEIO_API_BASE_URL || 'https://api.gateio.ws/api/v4';
  return new GateioApiService(baseUrl, gateioRateLimiter);
}

/**
 * Validate Gate.io API credentials
 *
 * @param apiKey - Gate.io API Key
 * @param apiSecret - Gate.io API Secret
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateGateioCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  const service = createGateioApiService();
  return await service.validateApiKey(apiKey, apiSecret);
}
