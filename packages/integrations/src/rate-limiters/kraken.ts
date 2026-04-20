/**
 * Kraken Rate Limiter Singleton
 *
 * Shared rate limiter instance for all Kraken API calls to ensure we don't exceed
 * the rate limit. Kraken uses a decay-based rate limit system.
 * Conservative limit: 15 calls per second for private endpoints
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Singleton rate limiter for Kraken API
 * 15 calls per second (conservative limit for private endpoints)
 */
export const krakenRateLimiter = new RateLimiter(15, 1000, { namespace: 'kraken' });
