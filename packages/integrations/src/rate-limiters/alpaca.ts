import { RateLimiter } from '@scani/rate-limiter';

/** Alpaca: 200 req/min per API key for paper, unlimited for live (throttled). */
export const alpacaRateLimiter = new RateLimiter(150, 60000, { namespace: 'alpaca' });
