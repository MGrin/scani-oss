/**
 * IBKR Rate Limiter Singleton
 *
 * Shared rate limiter instance for all IBKR Flex Query API calls.
 * IBKR is strict about rate limiting - conservative limit of 1 call per 10 seconds.
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Singleton rate limiter for IBKR Flex Query API
 * 1 call per 10 seconds (very conservative - IBKR is strict about rate limiting)
 */
export const ibkrRateLimiter = new RateLimiter(1, 10000);
