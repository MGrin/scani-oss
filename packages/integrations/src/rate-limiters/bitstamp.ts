/**
 * Bitstamp Rate Limiter Singleton
 *
 * Shared rate limiter instance for all Bitstamp API calls to ensure we don't exceed
 * the rate limit of 8 requests per 10 seconds across all operations
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Singleton rate limiter for Bitstamp API
 * 8 calls per 10 seconds
 */
export const bitstampRateLimiter = new RateLimiter(8, 10000, { namespace: 'bitstamp' });
