import { RateLimiter } from '@scani/rate-limiter';

/** bitFlyer private endpoints: 500 req / 5 min per key. Keep a margin. */
export const bitflyerRateLimiter = new RateLimiter(400, 300000, { namespace: 'bitflyer' });
