import { RateLimiter } from '@scani/rate-limiter';

/** Coincheck private endpoints ~5 req/sec per key. */
export const coincheckRateLimiter = new RateLimiter(5, 1000, { namespace: 'coincheck' });
