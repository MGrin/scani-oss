import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresResourceLock } from '../../src/locks/postgres-resource-lock';

/**
 * SC-518 introduced this class and SC-550 moved the two worker processors onto
 * it; until then it had no tests at all, and the two things it must do — hold a
 * key against a second caller, and let go on its own after `ttlMs` — were
 * asserted nowhere. A lock that never excludes passes every wiring test in the
 * repo, because the callers are written to skip silently when it says busy.
 *
 * Unlike `resource-lock-wiring.test.ts` in the worker, this file DOES call
 * `configure()` — deliberately. That file asserts a boot invariant and must
 * never establish its own precondition; this one is a unit test of the class,
 * where constructing the instance is the subject rather than the assumption.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set — the test preload sets it');

function makeLock(): PostgresResourceLock {
  const lock = new PostgresResourceLock();
  lock.configure(databaseUrl as string);
  return lock;
}

const opened: PostgresResourceLock[] = [];
function trackedLock(): PostgresResourceLock {
  const lock = makeLock();
  opened.push(lock);
  return lock;
}

afterAll(async () => {
  await Promise.all(opened.map((lock) => lock.close()));
});

describe('PostgresResourceLock', () => {
  test('acquires a free key', async () => {
    const lock = trackedLock();
    const result = await lock.acquire(`test:free:${crypto.randomUUID()}`, 30_000);
    expect(result.ok).toBe(true);
  });

  test('a second caller is refused while the first still holds it', async () => {
    // The property every caller of this class depends on. `holding-price-update`
    // and `refresh-account-balance` both skip their work when told busy, so a
    // lock that always granted would look healthy everywhere and coalesce
    // nothing — duplicate provider calls and concurrent vault recalculation,
    // which is the race the lock was introduced for.
    const key = `test:contended:${crypto.randomUUID()}`;
    const first = trackedLock();
    const second = trackedLock();

    const held = await first.acquire(key, 30_000);
    expect(held.ok).toBe(true);

    const refused = await second.acquire(key, 30_000);
    expect(refused.ok).toBe(false);
  });

  test('release frees the key for the next caller', async () => {
    const key = `test:released:${crypto.randomUUID()}`;
    const lock = trackedLock();

    const held = await lock.acquire(key, 30_000);
    if (!held.ok) throw new Error('expected to acquire a fresh key');
    await held.release();

    const again = await lock.acquire(key, 30_000);
    expect(again.ok).toBe(true);
  });

  test('an expired lock is taken by the next caller without a release', async () => {
    // The reason this is a table with an expiry column and not
    // `pg_advisory_lock`: a worker that HANGS keeps a healthy connection and
    // would hold an advisory lock forever, so the resource would never refresh
    // again. Nothing calls release here — expiry alone must be enough.
    const key = `test:expired:${crypto.randomUUID()}`;
    const holder = trackedLock();
    const next = trackedLock();

    const held = await holder.acquire(key, 1);
    expect(held.ok).toBe(true);
    await Bun.sleep(50);

    const taken = await next.acquire(key, 30_000);
    expect(taken.ok).toBe(true);
  });

  test('throws when used before configure', async () => {
    const lock = new PostgresResourceLock();
    await expect(lock.acquire('key', 100)).rejects.toThrow(/not configured/);
  });
});
