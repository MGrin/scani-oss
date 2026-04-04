/**
 * KuCoin Rate Limiter Singleton
 *
 * Shared rate limiter instance for all KuCoin API calls to ensure we don't exceed
 * the rate limit of 10 calls per second across all operations (validation, integration, etc.)
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Singleton rate limiter for KuCoin API
 * 10 calls per second (conservative limit)
 */
export const kucoinRateLimiter = new RateLimiter(10, 1000);
