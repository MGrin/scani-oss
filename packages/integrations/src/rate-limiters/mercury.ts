import { RateLimiter } from '@scani/rate-limiter';

/** Mercury API: ~100 req/min per token. Keep margin. */
export const mercuryRateLimiter = new RateLimiter(60, 60000, { namespace: 'mercury' });
