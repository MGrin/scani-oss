import { RateLimiter } from '@scani/rate-limiter';

/** Huobi: 10 requests per second */
export const huobiRateLimiter = new RateLimiter(10, 1000);
