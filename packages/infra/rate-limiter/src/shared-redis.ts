import type { Redis } from 'ioredis';

// Process-wide Redis handle for module-level rate-limiter construction
// (see `PricingService`'s GLOBAL_RATE_LIMITERS). Set once at app boot,
// then any code that wants a Redis-backed outflow limiter can pull this
// instead of taking Redis as a constructor dep.
//
// Prefer constructor injection where practical — this exists for the
// `const limiter = createOutflowLimiter({ redis: getSharedRedis(), … })`
// shape that module-level limiter declarations need.

let sharedRedis: Redis | null = null;

export function setSharedRedis(redis: Redis | null): void {
  sharedRedis = redis;
}

export function getSharedRedis(): Redis | null {
  return sharedRedis;
}
