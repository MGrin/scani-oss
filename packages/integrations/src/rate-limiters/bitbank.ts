import { RateLimiter } from '@scani/rate-limiter';

/** bitbank caps private endpoints at ~10 req/sec per key. */
export const bitbankRateLimiter = new RateLimiter(8, 1000, { namespace: 'bitbank' });
