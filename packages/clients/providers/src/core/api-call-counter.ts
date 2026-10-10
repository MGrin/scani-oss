import { createComponentLogger } from '@scani/logging';
import { getSharedRedis } from '@scani/rate-limiter';
import { Service } from 'typedi';

const logger = createComponentLogger('providers:ApiCallCounter');

const KEEP_SECONDS = 8 * 24 * 60 * 60;

export function apiCallsKey(at: Date, namespace: string): string {
  return `api:calls:${at.toISOString().slice(0, 10)}:${namespace}`;
}

/**
 * Upstream calls per UTC day and rate-limiter namespace, kept eight days, so a
 * change to sync cadence is measured rather than estimated (SC-1665). Nothing
 * counted them before: the outflow limiter's sliding window expires every
 * window. Same shape as SC-1610's `CacheWriteCounter`: Redis in every deployed
 * process, an in-memory map otherwise, and a count that cannot be written is
 * logged and never fails the call it counts.
 */
@Service()
export class ApiCallCounter {
  private readonly local = new Map<string, number>();

  add(namespace: string, at: Date = new Date()): void {
    const key = apiCallsKey(at, namespace);
    const redis = getSharedRedis();
    if (!redis) {
      this.local.set(key, (this.local.get(key) ?? 0) + 1);
      return;
    }
    redis
      .multi()
      .incr(key)
      .expire(key, KEEP_SECONDS)
      .exec()
      .catch((error: unknown) => logger.warn({ error, key }, 'Could not count an upstream call'));
  }

  async read(at: Date, namespace: string): Promise<number> {
    const key = apiCallsKey(at, namespace);
    const redis = getSharedRedis();
    if (!redis) return this.local.get(key) ?? 0;
    return Number((await redis.get(key)) ?? 0);
  }
}
