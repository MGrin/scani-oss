import { RateLimiter } from '@scani/rate-limiter';

/** Bitfinex authenticated endpoints: 90 req / 60 s per key. Keep a margin. */
export const bitfinexRateLimiter = new RateLimiter(60, 60000, { namespace: 'bitfinex' });
