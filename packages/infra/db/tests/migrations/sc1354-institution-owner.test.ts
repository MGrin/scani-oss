import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src';
import type { DatabaseTransaction } from '../../src/transaction';

/**
 * SC-1354's backfill, run verbatim against the real schema inside a
 * transaction that is rolled back. The columns already exist on this database,
 * so only the UPDATE statements are replayed, after every row is put back to
 * the state the migration found: unverified, no owner.
 */
const MIGRATION = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'migrations',
  '20260926094529_institution_owner_and_verified_flag.sql'
);

const updates = readFileSync(MIGRATION, 'utf8')
  .replace(/--.*$/gm, '')
  .split(';')
  .map((s) => s.trim())
  .filter((s) => /^UPDATE\b/i.test(s));

class Rollback extends Error {}
type Tx = DatabaseTransaction;

async function one<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await tx.execute(query)) as unknown as T[];
  if (!rows[0]) throw new Error('query returned no row');
  return rows[0];
}

const id = (tx: Tx, query: ReturnType<typeof sql>) =>
  one<{ id: string }>(tx, query).then((r) => r.id);

const state = (tx: Tx, institutionId: string) =>
  one<{ verified: boolean; owner: string | null }>(
    tx,
    sql`SELECT is_verified AS verified, created_by_user_id AS owner FROM institutions WHERE id = ${institutionId}`
  );

test('the backfill verifies the seeded catalogue and gives typed rows to their one user', async () => {
  expect(updates).toHaveLength(3);
  const seen: Record<string, { verified: boolean; owner: string | null }> = {};
  let alice = '';
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`UPDATE institutions SET is_verified = false, created_by_user_id = NULL`);
      const typeId = await id(tx, sql`SELECT id FROM institution_types LIMIT 1`);
      const accountTypeId = await id(tx, sql`SELECT id FROM account_types LIMIT 1`);
      const user = (label: string) =>
        id(
          tx,
          sql`INSERT INTO users (email, name) VALUES (concat('sc1354-', ${label}::text, '-', gen_random_uuid(), '@example.test'), ${label}::text) RETURNING id`
        );
      alice = await user('alice');
      const bob = await user('bob');
      const institution = (name: string, integration = false) =>
        id(
          tx,
          sql`INSERT INTO institutions (name, type_id, has_integration) VALUES (${name}, ${typeId}, ${integration}) RETURNING id`
        );
      const account = (userId: string, institutionId: string) =>
        tx.execute(
          sql`INSERT INTO accounts (user_id, institution_id, name, type_id) VALUES (${userId}, ${institutionId}, concat('acct-', gen_random_uuid()), ${accountTypeId})`
        );
      const typedOne = await institution('sc1354 typed by alice');
      await account(alice, typedOne);
      const typedShared = await institution('sc1354 used by two');
      await account(alice, typedShared);
      await account(bob, typedShared);
      const unused = await institution('sc1354 unused');
      const integrated = await institution('sc1354 integrated', true);
      const seeded = await id(
        tx,
        sql`SELECT id FROM institutions WHERE website = 'https://ethereum.org'`
      );

      for (const statement of updates) await tx.execute(sql.raw(statement));

      seen.typedOne = await state(tx, typedOne);
      seen.typedShared = await state(tx, typedShared);
      seen.unused = await state(tx, unused);
      seen.integrated = await state(tx, integrated);
      seen.seeded = await state(tx, seeded);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  expect(seen.seeded).toEqual({ verified: true, owner: null });
  expect(seen.integrated).toEqual({ verified: true, owner: null });
  expect(seen.typedShared).toEqual({ verified: true, owner: null });
  expect(seen.typedOne).toEqual({ verified: false, owner: alice });
  expect(seen.unused).toEqual({ verified: false, owner: null });
});
