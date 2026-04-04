/**
 * Gemini Rate Limiter Singleton
 *
 * Shared rate limiter instance for all Gemini API calls to ensure we don't exceed
 * the rate limit of 5 requests per second across all operations
 */

import { RateLimiter } from '@scani/rate-limiter';

/**
 * Singleton rate limiter for Gemini API
 * 5 calls per second
 */
export const geminiRateLimiter = new RateLimiter(5, 1000);
