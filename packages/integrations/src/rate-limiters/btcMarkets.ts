import { RateLimiter } from '@scani/rate-limiter';

/** BTC Markets caps authenticated endpoints at 50 req / 10 s per IP. */
export const btcMarketsRateLimiter = new RateLimiter(40, 10000, { namespace: 'btcMarkets' });
