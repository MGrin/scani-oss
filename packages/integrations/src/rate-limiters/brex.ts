import { RateLimiter } from '@scani/rate-limiter';

/** Brex public rate limits ~1000 req/min per token. */
export const brexRateLimiter = new RateLimiter(100, 60000, { namespace: 'brex' });
