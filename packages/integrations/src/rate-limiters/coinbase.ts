/**
 * Coinbase Rate Limiter Singleton
 *
 * Shared rate limiter instance for all Coinbase API calls to ensure we don't exceed
 * the rate limit of 10 requests per second across all operations
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Singleton rate limiter for Coinbase API
 * 10 calls per second
 */
export const coinbaseRateLimiter = new RateLimiter(10, 1000, { namespace: 'coinbase' });
