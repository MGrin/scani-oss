import { Service } from 'typedi';
import { getSharedRedis } from '../shared-redis';
import { InMemoryOutflowRateLimiter } from './in-memory';
import type { OutflowRateLimiter } from './outflow-rate-limiter';
import { RedisOutflowRateLimiter } from './redis';

export interface OutflowLimiterConfig {
  /** Stable identifier — also the Redis key suffix when running on Redis. */
  namespace: string;
  maxRequests: number;
  windowMs: number;
}

interface CacheEntry {
  config: OutflowLimiterConfig;
  limiter: OutflowRateLimiter;
}

/**
 * Process-wide cache of outflow limiters keyed by namespace.
 *
 * Two services that hit the same upstream API (e.g. CoinGecko) must
 * share one limiter so they share the upstream budget. The registry
 * makes that sharing structural rather than incidental: every consumer
 * resolves the limiter via `get(config)` instead of importing a module-
 * level constant or grabbing a public field off another service.
 *
 * Consistency is enforced — a second `get` for the same namespace with
 * a different `maxRequests` or `windowMs` throws. Two consumers of
 * the same upstream API have no business disagreeing on the rate.
 *
 * Backend choice (Redis vs in-memory) is centralised here. The shared
 * Redis handle (`setSharedRedis(...)`) wins when set; otherwise the
 * registry hands back in-memory limiters (the right behaviour for
 * tests + truly single-process deployments).
 */
@Service()
export class OutflowRateLimiterRegistry {
  private readonly cache = new Map<string, CacheEntry>();

  get(config: OutflowLimiterConfig): OutflowRateLimiter {
    const cached = this.cache.get(config.namespace);
    if (cached) {
      if (
        cached.config.maxRequests !== config.maxRequests ||
        cached.config.windowMs !== config.windowMs
      ) {
        throw new Error(
          `OutflowRateLimiterRegistry: namespace '${config.namespace}' already registered with ` +
            `{ maxRequests: ${cached.config.maxRequests}, windowMs: ${cached.config.windowMs} }; ` +
            `re-registration with { maxRequests: ${config.maxRequests}, windowMs: ${config.windowMs} } would split the budget.`
        );
      }
      return cached.limiter;
    }

    const redis = getSharedRedis();
    const limiter: OutflowRateLimiter = redis
      ? new RedisOutflowRateLimiter({
          redis,
          namespace: config.namespace,
          maxRequests: config.maxRequests,
          windowMs: config.windowMs,
        })
      : new InMemoryOutflowRateLimiter(config.maxRequests, config.windowMs);

    this.cache.set(config.namespace, { config, limiter });
    return limiter;
  }
}
