/**
 * Gate.io Rate Limiter Singleton
 *
 * Shared rate limiter instance for all Gate.io API calls to ensure we don't exceed
 * the rate limit of 10 calls per second across all operations (validation, integration, etc.)
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Singleton rate limiter for Gate.io API
 * 10 calls per second (conservative limit)
 */
export const gateioRateLimiter = new RateLimiter(10, 1000, { namespace: 'gateio' });
