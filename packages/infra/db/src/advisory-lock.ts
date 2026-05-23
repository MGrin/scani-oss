import { client } from './connection';

/**
 * Distributed mutual exclusion via PostgreSQL session-level advisory locks.
 *
 * Used to serialize logical units of work that span multiple processes /
 * containers — e.g. cron jobs (so a redeploy-overlapping pair of workers
 * doesn't double-run a nightly task), or per-user pipelines (so a
 * user-initiated backfill and the cron sweep don't race on the same
 * user's rows).
 *
 * Behaviour: if the lock is already held, `fn` is NOT executed and the
 * caller receives `{ ran: false }`. The expectation is that either the
 * other holder is doing the work (caller can no-op safely) or the caller
 * will retry on the next tick. Lock is auto-released when the reserved
 * connection is returned to the pool, with explicit unlock on the happy
 * path as belt-and-braces.
 */

function hashKey(key: string): bigint {
  // FNV-1a 64-bit, then squeezed into the signed-int64 range Postgres
  // accepts. Deterministic, fast, no crypto needed (these are coordination
  // hashes, not security tokens).
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_64 = (1n << 64n) - 1n;
  let hash = FNV_OFFSET;
  for (let i = 0; i < key.length; i++) {
    hash ^= BigInt(key.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  const SIGNED_MAX = (1n << 63n) - 1n;
  return hash > SIGNED_MAX ? hash - (1n << 64n) : hash;
}

export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  const lockKey = hashKey(key).toString();
  const reserved = await client.reserve();

  try {
    const rows = (await reserved.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
      lockKey,
    ])) as Array<{ locked: boolean }>;
    const locked = rows[0]?.locked === true;
    if (!locked) return { ran: false };

    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      try {
        await reserved.unsafe('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
      } catch {
        // Auto-release on connection close still applies.
      }
    }
  } finally {
    reserved.release();
  }
}
