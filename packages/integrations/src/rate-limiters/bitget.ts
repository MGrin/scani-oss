/**
 * Bitget Rate Limiter Singleton
 *
 * Shared rate limiter instance for all Bitget API calls to ensure we don't exceed
 * the rate limit of 10 requests per second across all operations
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Singleton rate limiter for Bitget API
 * 10 calls per second
 */
export const bitgetRateLimiter = new RateLimiter(10, 1000);
