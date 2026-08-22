import { afterAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { PostgresResourceLock, type ResourceLock } from '@scani/queue';
import { Container } from 'typedi';
import { HoldingPriceUpdateProcessor } from '../../src/processors/holding-price-update';
import { RefreshAccountBalanceProcessor } from '../../src/processors/refresh-account-balance';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-550. Two processors injected `RedisResourceLock` while boot configured
 * `PostgresResourceLock`, so `acquire()` threw on the first call in production
 * and both job types retried into the DLQ.
 *
 * DO NOT CALL `configure()` ON THE LOCK UNDER TEST IN THIS FILE. That is the
 * whole point, and it is the line a future reader will most want to add when
 * this file goes red.
 *
 * `redis-resource-lock.test.ts` was green throughout the outage because every
 * one of its cases calls `lock.configure(stubRedis)` before exercising
 * `acquire()`. It verifies the configured path — a state worker boot never
 * produces for that class — so it could not have failed for the reason anyone
 * cared about. A test that constructs its own precondition cannot detect a
 * precondition nobody establishes.
 *
 * So the only setup below is the one line boot actually runs
 * (`apps/backend/worker/src/index.ts`), and the locks are then exercised
 * exactly as the processors exercise them. Type-check cannot reach this:
 * `Container.get(RedisResourceLock)` is correctly typed and returns exactly
 * what the field declares — the defect is that the instance was never
 * configured.
 */

// The processors hold their lock privately, which is right for production
// code; the test reaches it by cast rather than by widening the field.
function lockOf(processor: object): ResourceLock {
  return (processor as { resourceLock: ResourceLock }).resourceLock;
}

const WORKER_SRC = join(import.meta.dir, '..', '..', 'src');

// Everything boot does about resource locks, and nothing else.
// Mirrors `Container.get(PostgresResourceLock).configure(env.DATABASE_URL)`.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set — the test preload sets it');
Container.get(PostgresResourceLock).configure(databaseUrl);

afterAll(async () => {
  // `configure()` opens a pg Pool; leaving it open holds the suite's event loop.
  await Container.get(PostgresResourceLock).close();
});

describe('worker processors acquire the lock boot configured', () => {
  const cases: Array<{ name: string; processor: object }> = [
    { name: 'holding-price-update', processor: Container.get(HoldingPriceUpdateProcessor) },
    { name: 'refresh-account-balance', processor: Container.get(RefreshAccountBalanceProcessor) },
  ];

  for (const { name, processor } of cases) {
    test(`${name} acquires and releases without reconfiguring anything`, async () => {
      const key = `test:sc-550:${name}:${crypto.randomUUID()}`;

      // In the broken state this line THROWS
      // "RedisResourceLock not configured — call configure(redis) at boot",
      // which is precisely what production did on every one of these jobs.
      const lock = await lockOf(processor).acquire(key, 30_000);

      expect(lock.ok).toBe(true);
      if (lock.ok) await lock.release();
    });
  }
});

/**
 * The runtime cases above cover the two processors that exist today. This one
 * covers the next one: SC-550 happened because SC-518 fixed the boot site and
 * the class and missed the CONSUMERS, and nothing enumerated them. A new
 * processor reaching for `RedisResourceLock` would pass every test above by
 * simply not being listed in them.
 */
describe('every resource lock the worker consumes is one the worker configures', () => {
  function readWorkerSources(dir: string): Array<{ path: string; source: string }> {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return readWorkerSources(path);
      return entry.isFile() && entry.name.endsWith('.ts')
        ? [{ path, source: readFileSync(path, 'utf8') }]
        : [];
    });
  }

  const sources = readWorkerSources(WORKER_SRC);

  const configured = new Set(
    sources.flatMap(({ source }) =>
      [...source.matchAll(/Container\.get\((\w*ResourceLock)\)\s*\.configure\(/g)].map(
        (match) => match[1] as string
      )
    )
  );

  const consumed = sources.flatMap(({ path, source }) =>
    [...source.matchAll(/Container\.get\((\w*ResourceLock)\)(?!\s*\.configure\()/g)].map(
      (match) => ({ path, lock: match[1] as string })
    )
  );

  test('the scan found the call sites it is asserting over', () => {
    // A regex that matches nothing passes the real assertion vacuously, which
    // is the failure mode this whole file exists to close. Both counts are
    // non-zero facts about the tree, so a rename that breaks the scan fails
    // here rather than quietly reporting that everything is fine.
    expect(configured.size).toBeGreaterThan(0);
    expect(consumed.length).toBeGreaterThan(0);
  });

  test('no processor injects a lock that boot never configures', () => {
    const unconfigured = consumed
      .filter(({ lock }) => !configured.has(lock))
      .map(({ path, lock }) => `${path.slice(WORKER_SRC.length + 1)} injects ${lock}`);

    expect(unconfigured).toEqual([]);
  });
});
