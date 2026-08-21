import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { sql } from 'drizzle-orm';
import { assertDemoOnlyDatabase, DemoModeRefused } from '../../src/demo';
import { buildDemoDataset } from '../../src/demo/dataset';
import { withTestDb } from '../../test/helpers/db';

/**
 * SC-466, layer 2: the boot guard reading a real database.
 *
 * `mode.test.ts` covers the decision; this covers the READ, because those are
 * different things that can each be wrong on their own — a guard querying the
 * wrong column or the wrong table would pass every unit test above and refuse
 * (or accept) everything here.
 *
 * Every case runs inside a rolled-back transaction and is handed that
 * transaction, so the assertions are about rows this file inserted rather than
 * about whatever else the gate database happens to hold.
 */

const demoUser = buildDemoDataset().user;

/**
 * Inside the rolled-back transaction, so the gate database is untouched.
 * `TRUNCATE ... CASCADE` rather than a delete because `users` has dependents
 * without `ON DELETE CASCADE` (`token_price_edit_history` is one), and the
 * point of these cases is what the guard sees in `users` — not an inventory of
 * which foreign keys happen to cascade today.
 */
async function emptyUsers(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  await tx.execute(sql`TRUNCATE TABLE users CASCADE`);
}

async function insertUser(
  tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
  email: string,
  id: string
) {
  await tx.insert(schema.users).values({
    id,
    email,
    name: 'Test',
    emailVerified: true,
  });
}

describe('assertDemoOnlyDatabase', () => {
  test('ACCEPTS a database holding the demo persona and nobody else', async () => {
    await withTestDb(async (tx) => {
      await emptyUsers(tx);
      await insertUser(tx, demoUser.email, demoUser.id);
      await expect(assertDemoOnlyDatabase(tx)).resolves.toBeUndefined();
    });
  });

  test('refuses as soon as one other account exists', async () => {
    await withTestDb(async (tx) => {
      await emptyUsers(tx);
      await insertUser(tx, demoUser.email, demoUser.id);
      await insertUser(tx, 'real.person@example.com', '11111111-1111-4111-8111-111111111111');
      await expect(assertDemoOnlyDatabase(tx)).rejects.toThrow(DemoModeRefused);
    });
  });

  test('refuses a database with no users at all', async () => {
    await withTestDb(async (tx) => {
      await emptyUsers(tx);
      await expect(assertDemoOnlyDatabase(tx)).rejects.toThrow(DemoModeRefused);
    });
  });
});
