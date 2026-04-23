/**
 * Independent Reserve Integration Factory
 *
 * Creates an IndependentReserveApiService with the production base URL
 * and the shared rate limiter, and exposes a validator used by the
 * backend router for pre-enqueue credential checks.
 */

import { independentReserveRateLimiter } from '../rate-limiters/independentReserve';
import { IndependentReserveApiService } from '../services/IndependentReserveApiService';

export function createIndependentReserveApiService(): IndependentReserveApiService {
  const baseUrl =
    process.env.INDEPENDENT_RESERVE_API_BASE_URL || 'https://api.independentreserve.com';
  return new IndependentReserveApiService(baseUrl, independentReserveRateLimiter);
}

export async function validateIndependentReserveCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  const service = createIndependentReserveApiService();
  return await service.validateApiKey(apiKey, apiSecret);
}
