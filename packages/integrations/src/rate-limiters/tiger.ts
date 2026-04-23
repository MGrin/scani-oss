import { RateLimiter } from '@scani/rate-limiter';

/** Tiger Open API rate limits vary per method (most 120/min). Keep margin. */
export const tigerRateLimiter = new RateLimiter(80, 60000, { namespace: 'tigerBrokers' });
