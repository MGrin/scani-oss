import { createComponentLogger } from '@scani/logging';
import { getSharedRedis } from '@scani/rate-limiter';
import { Service } from 'typedi';

const logger = createComponentLogger('service:CacheWriteCounter');

/** Which scheduled price write wrote the value cache (SC-1610). */
export type CacheWriteTrigger = 'hourly' | 'active' | 'fx';

const KEEP_SECONDS = 8 * 24 * 60 * 60;

export function cacheWritesKey(at: Date, trigger: CacheWriteTrigger): string {
  return `cache:writes:${at.toISOString().slice(0, 10)}:${trigger}`;
}

/**
 * The value cache's writes per UTC day and price run, kept eight days, so one
 * read splits writes per day by trigger (SC-1610). A job's result could not:
 * bullmq keeps only the last few runs. Redis in every deployed process; the
 * in-memory map serves a process with no shared Redis, a test or a bare local
 * run. A count that cannot be written is logged and never fails a price run.
 */
@Service()
export class CacheWriteCounter {
  private readonly local = new Map<string, number>();

  async add(trigger: CacheWriteTrigger, writes: number, at: Date = new Date()): Promise<void> {
    const key = cacheWritesKey(at, trigger);
    const redis = getSharedRedis();
    if (!redis) {
      this.local.set(key, (this.local.get(key) ?? 0) + writes);
      return;
    }
    try {
      await redis.multi().incrby(key, writes).expire(key, KEEP_SECONDS).exec();
    } catch (error) {
      logger.warn({ error, key, writes }, 'Could not count value cache writes');
    }
  }

  async read(at: Date, trigger: CacheWriteTrigger): Promise<number> {
    const key = cacheWritesKey(at, trigger);
    const redis = getSharedRedis();
    if (!redis) return this.local.get(key) ?? 0;
    return Number((await redis.get(key)) ?? 0);
  }
}
