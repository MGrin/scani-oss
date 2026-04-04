/**
 * Wise Rate Limiter Singleton
 *
 * Shared rate limiter instance for all Wise API calls to ensure we don't exceed
 * the rate limit of ~100 requests per minute.
 * Conservative limit: ~1.5 calls per second (90 per minute)
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Singleton rate limiter for Wise API
 * ~1.5 calls per second (conservative limit for ~100/min)
 */
export const wiseRateLimiter = new RateLimiter(2, 1000);
