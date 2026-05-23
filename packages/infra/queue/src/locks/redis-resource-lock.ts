import type { Redis } from 'ioredis';
import { Service } from 'typedi';
import {
  ResourceLock,
  type ResourceLockAcquired,
  type ResourceLockBusy,
} from '../consumer/resource-lock';

// Redis SET-NX based per-resource lock with TTL. Keys are caller-defined
// (e.g., `holding-price-update:<holdingId>`). Auto-expires on TTL so a
// crashed holder doesn't block forever.
@Service()
export class RedisResourceLock extends ResourceLock {
  private redis: Redis | null = null;

  configure(redis: Redis): void {
    this.redis = redis;
  }

  override async acquire(
    key: string,
    ttlMs: number
  ): Promise<ResourceLockAcquired | ResourceLockBusy> {
    if (!this.redis) {
      throw new Error('RedisResourceLock not configured — call configure(redis) at boot');
    }
    const redis = this.redis;
    const result = await redis.set(key, '1', 'PX', ttlMs, 'NX');
    if (result !== 'OK') return { ok: false };
    return {
      ok: true,
      release: async () => {
        try {
          await redis.del(key);
        } catch {
          // Lock auto-expires on TTL anyway; release is best-effort.
        }
      },
    };
  }
}
