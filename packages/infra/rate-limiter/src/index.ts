import type { Redis } from 'ioredis';
import { InMemoryInflowRateLimiter } from './inflow/in-memory';
import type { InflowRateLimiter, InflowRateLimiterOptions } from './inflow/inflow-rate-limiter';
import { RedisInflowRateLimiter } from './inflow/redis';
import { InMemoryOutflowRateLimiter } from './outflow/in-memory';
import type { OutflowRateLimiter } from './outflow/outflow-rate-limiter';
import { RedisOutflowRateLimiter } from './outflow/redis';

export { credentialBucketKey } from './credential-key';
export { InMemoryInflowRateLimiter } from './inflow/in-memory';
export {
  defaultInflowKey,
  extractXffTail,
  type InflowKeyFn,
  InflowRateLimiter,
  type InflowRateLimiterOptions,
} from './inflow/inflow-rate-limiter';
export { RedisInflowRateLimiter } from './inflow/redis';
export { InMemoryOutflowRateLimiter } from './outflow/in-memory';
export { OutflowRateLimiter } from './outflow/outflow-rate-limiter';
export {
  RedisOutflowRateLimiter,
  type RedisOutflowRateLimiterOptions,
} from './outflow/redis';
export {
  type OutflowLimiterConfig,
  OutflowRateLimiterRegistry,
} from './outflow/registry';
// Resilience primitives — sit in this package alongside rate-limiting
// because both are upstream-boundary protections. Limiters cap call
// rate; circuit breakers stop calling when the upstream is clearly
// failing; retry wraps individual calls when the failure looks transient.
export {
  CircuitBreaker,
  integrationCircuitBreaker,
  pricingCircuitBreaker,
} from './resilience/circuit-breaker';
export { defaultIsTransient, type RetryOptions, withRetry } from './resilience/retry';
export { getSharedRedis, setSharedRedis } from './shared-redis';

// Picks the right outflow impl based on whether a Redis client is
// supplied. Module-level limiter declarations (PricingService) typically
// pass `redis: getSharedRedis()` so they get Redis-backed when the host
// app initialised it, in-memory when running standalone (tests).
export function createOutflowLimiter(opts: {
  maxRequests: number;
  windowMs: number;
  redis?: Redis | null;
  /** Required when `redis` is provided. */
  namespace?: string;
}): OutflowRateLimiter {
  if (opts.redis) {
    if (!opts.namespace) {
      throw new Error('createOutflowLimiter: `namespace` is required when `redis` is provided');
    }
    return new RedisOutflowRateLimiter({
      redis: opts.redis,
      namespace: opts.namespace,
      maxRequests: opts.maxRequests,
      windowMs: opts.windowMs,
    });
  }
  return new InMemoryOutflowRateLimiter(opts.maxRequests, opts.windowMs);
}

// Same picker for inflow. The api/data-provider always have Redis at
// boot, so production paths get Redis; an OSS self-host without Redis
// would get the in-memory fallback automatically.
export function createInflowLimiter(
  redis: Redis | null,
  opts: InflowRateLimiterOptions
): InflowRateLimiter {
  if (redis) return new RedisInflowRateLimiter(redis, opts);
  return new InMemoryInflowRateLimiter(opts);
}

// Common factory presets — names match the original backend callers
// to minimise migration churn.
export const createStandardLimiter = (redis: Redis | null, perMinute = 120): InflowRateLimiter =>
  createInflowLimiter(redis, { windowMs: 60_000, max: perMinute, namespace: 'rl:standard' });

export const createStrictLimiter = (redis: Redis | null, perMinute = 20): InflowRateLimiter =>
  createInflowLimiter(redis, { windowMs: 60_000, max: perMinute, namespace: 'rl:strict' });

// Per-IP signup throttle. Defends against account-enumeration brute
// force: even though Better-Auth's signup response shape still
// distinguishes "exists" from "new", an attacker can only probe N
// emails per hour per IP before getting 429s. Pair with the existing
// global + strict limiters. Keep the default conservative — real
// users sign up at most a handful of times per IP per hour (shared
// office NAT, etc.).
export const createSignupLimiter = (redis: Redis | null, perHour = 6): InflowRateLimiter =>
  createInflowLimiter(redis, {
    windowMs: 60 * 60 * 1000,
    max: perHour,
    namespace: 'rl:signup',
  });

// Per-user limiter for session-revocation actions. The route correctly
// scopes revocation by ownership (an attacker with one stolen session
// can't revoke another user's sessions), but with no per-user budget a
// compromised session can loop-revoke the victim's OTHER devices to
// lock them out. 10/min is well above any legitimate revoke pattern
// (the UI lists sessions and a user clicks one at a time).
export const createSessionRevokeLimiter = (
  redis: Redis | null,
  perMinute = 10
): InflowRateLimiter =>
  createInflowLimiter(redis, {
    windowMs: 60_000,
    max: perMinute,
    namespace: 'rl:session-revoke',
  });
