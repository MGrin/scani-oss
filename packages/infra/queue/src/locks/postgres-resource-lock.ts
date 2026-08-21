import { createComponentLogger } from '@scani/logging';
import { Pool } from 'pg';
import { Service } from 'typedi';
import {
  ResourceLock,
  type ResourceLockAcquired,
  type ResourceLockBusy,
} from '../consumer/resource-lock';

const log = createComponentLogger('queue:resource-lock');

/**
 * Per-resource TTL-bounded lock on Postgres. Replaces `RedisResourceLock`.
 *
 * Deliberately NOT a `pg_advisory_lock`, even though this repo already has that
 * pattern in `apps/backend/worker/src/lib/cron-lock.ts` and it would have been
 * the obvious thing to reach for. An advisory lock is held until the session
 * releases it or the connection dies — it has no TTL. The Redis lock this
 * replaces is `SET key NX PX ttlMs`, which expires on its own schedule whether
 * or not the holder is alive.
 *
 * Those differ in the case the lock exists for: a worker that hangs rather than
 * crashes holds an advisory lock indefinitely (its connection is fine), while
 * the Redis lock frees the resource after `ttlMs`. Since callers pass a TTL and
 * `holding-price-update` is written to skip-if-locked, a lock that outlives its
 * TTL would silently stop that holding from ever refreshing again.
 *
 * So this keeps `SET NX PX` semantics exactly: an expiry column, and a
 * conditional upsert that only takes the row when the current holder's expiry
 * has already passed.
 */
@Service()
export class PostgresResourceLock extends ResourceLock {
  private pool: Pool | null = null;

  configure(connectionString: string): void {
    this.pool = new Pool({ connectionString, max: 4 });
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  override async acquire(
    key: string,
    ttlMs: number
  ): Promise<ResourceLockAcquired | ResourceLockBusy> {
    const pool = this.pool;
    if (!pool) {
      throw new Error('PostgresResourceLock not configured — call configure(url) at boot');
    }

    // The `WHERE ... expires_at <= now()` on the conflict path is the whole
    // lock: an upsert without it would let a second caller steal a live lock,
    // and `DO NOTHING` would return no row on the expired-but-present case and
    // report busy forever.
    const { rows } = await pool.query<{ resource_key: string }>(
      `INSERT INTO queue_resource_locks (resource_key, expires_at)
            VALUES ($1, now() + make_interval(secs => $2::double precision))
       ON CONFLICT (resource_key) DO UPDATE
              SET expires_at = EXCLUDED.expires_at
            WHERE queue_resource_locks.expires_at <= now()
        RETURNING resource_key`,
      [key, ttlMs / 1000]
    );

    if (rows.length === 0) return { ok: false };

    return {
      ok: true,
      release: async () => {
        try {
          await pool.query('DELETE FROM queue_resource_locks WHERE resource_key = $1', [key]);
        } catch (err) {
          // Best-effort, exactly as the Redis version was: the row expires on
          // its own, so a failed release costs at most `ttlMs` of contention.
          log.warn(
            { key, error: err instanceof Error ? err.message : String(err) },
            'resource lock release failed — falling back to TTL expiry'
          );
        }
      },
    };
  }
}
