import { randomUUID } from 'node:crypto';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';

/** A heavy-read budget no test will spend, for the ones that are not about it. */
export function roomyHeavyLimiter(): InMemoryInflowRateLimiter {
  return new InMemoryInflowRateLimiter({
    windowMs: 60_000,
    max: 100_000,
    namespace: `rl:test-heavy-${randomUUID()}`,
  });
}
