/**
 * Rate Limiter for Plaid API
 *
 * Plaid API rate limits:
 * - Sandbox: 100 requests/minute
 * - Development: 100 requests/minute
 * - Production: 500 requests/minute (can request increase)
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Plaid rate limiter instance
 * Configured for development environment (100 req/min)
 * Adjust maxRequests for production (500 req/min)
 */
export const plaidRateLimiter = new RateLimiter(
  100, // maxRequests - Adjust to 500 for production
  60000 // intervalMs - 1 minute
);
