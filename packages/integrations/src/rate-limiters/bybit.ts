/**
 * Bybit Rate Limiter Singleton
 *
 * Shared rate limiter instance for all Bybit API calls to ensure we don't exceed
 * the rate limit of 10 requests per second across all operations
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Singleton rate limiter for Bybit API
 * 10 calls per second
 */
export const bybitRateLimiter = new RateLimiter(10, 1000);
