import { RateLimiter } from '@scani/rate-limiter';

/** Tinkoff Invest: per-method rate limits (most are 300/min). Keep margin. */
export const tinkoffRateLimiter = new RateLimiter(200, 60000, { namespace: 'tinkoff' });
