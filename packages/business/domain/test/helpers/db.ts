/**
 * Test database helpers.
 *
 * Pattern: each test runs inside a transaction that's rolled back on
 * teardown, so no test bleeds state into the next. Uses the compose
 * Postgres (localhost:5433) via `DATABASE_URL` — same DB, same schema,
 * same migrations as dev. No separate test DB to provision.
 *
 * Usage:
 *   import { withTestDb } from './helpers/db';
 *
 *   test('insert a user_jobs row', async () => {
 *     await withTestDb(async (tx) => {
 *       const repo = Container.get(UserJobRepository);
 *       await repo.insertEnqueued({ ... }, tx);
 *       // assertions on `tx` ...
 *     });
 *   });
 *
 * The `withTestDb` callback receives a `DatabaseTransaction` that is
 * rolled back after the callback returns (whether it resolved or
 * rejected). Repositories accept this as their optional transaction
 * parameter, so no production code needs a test-only shim.
 */

import { type DatabaseTransaction, getDb } from '@scani/db';

class TestRollback extends Error {
  constructor() {
    super('__test_rollback__');
  }
}

export async function withTestDb<T>(
  fn: (tx: DatabaseTransaction) => Promise<T>
): Promise<T | undefined> {
  const db = getDb();
  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      result = await fn(tx);
      throw new TestRollback();
    });
  } catch (err) {
    if (err instanceof TestRollback) return result;
    throw err;
  }
  return result;
}
