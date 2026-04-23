import { RateLimiter } from '@scani/rate-limiter';

/** Kite Connect: 10 req/sec per API key on portfolio endpoints. */
export const zerodhaRateLimiter = new RateLimiter(8, 1000, { namespace: 'zerodha' });
