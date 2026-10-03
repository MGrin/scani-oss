import { expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { inRollback, type Query, refusedWith, type Tx } from './foundation-helpers';

/**
 * The two report tables the foundation shadows write. What is pinned here is
 * what the repository test cannot see: the vocabularies the CHECKs hold, and
 * which parent takes a difference with it and which only clears its reference.
 * A price difference belongs to no user, so `user_id` is nullable; a user's
 * differences go with the user, and a holding or a token going leaves the
 * difference standing with the reference cleared.
 */

async function one<T>(tx: Tx, query: Query): Promise<T> {
  const [row] = (await tx.execute(query)) as unknown as T[];
  if (!row) throw new Error('query returned no row');
  return row;
}

const id = (tx: Tx, query: Query) => one<{ id: string }>(tx, query).then((r) => r.id);

const insertRun = (kind: string, status: string, scope = 'all') =>
  sql`INSERT INTO engine_shadow_runs (kind, as_of, started_at, finished_at, status, scope)
      VALUES (${kind}, now(), now(), now(), ${status}, ${scope}) RETURNING id`;

test('a run is a balance or a price run, complete or failed, over all users or one, and says which', async () => {
  await inRollback(async (tx) => {
    for (const kind of ['balance', 'price']) {
      for (const status of ['complete', 'failed']) {
        for (const scope of ['all', 'user']) {
          expect(await refusedWith(tx, insertRun(kind, status, scope))).toBe(undefined);
        }
      }
    }
    expect(await refusedWith(tx, insertRun('portfolio', 'complete'))).toBe('23514');
    expect(await refusedWith(tx, insertRun('balance', 'running'))).toBe('23514');
    expect(await refusedWith(tx, insertRun('balance', 'complete', 'account'))).toBe('23514');

    // No default: a writer that omits the scope must not count as a full run.
    expect(
      await refusedWith(
        tx,
        sql`INSERT INTO engine_shadow_runs (kind, as_of, started_at, finished_at, status)
            VALUES ('balance', now(), now(), now(), 'complete')`
      )
    ).toBe('23502');
  });
});

test("a user's differences go with the user; a holding or token going clears the reference", async () => {
  await inRollback(async (tx) => {
    const userId = await id(
      tx,
      sql`INSERT INTO users (email, name) VALUES (concat('engine-shadow-', gen_random_uuid(), '@example.test'), 'shadow') RETURNING id`
    );
    const institutionId = await id(
      tx,
      sql`INSERT INTO institutions (name, type_id) VALUES (concat('shadow-', gen_random_uuid()), (SELECT id FROM institution_types LIMIT 1)) RETURNING id`
    );
    const accountId = await id(
      tx,
      sql`INSERT INTO accounts (user_id, institution_id, name, type_id) VALUES (${userId}, ${institutionId}, concat('acct-', gen_random_uuid()), (SELECT id FROM account_types LIMIT 1)) RETURNING id`
    );
    const tokenTypeId = await id(
      tx,
      sql`INSERT INTO token_types (code, name) VALUES ('crypto', 'Crypto') ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`
    );
    const token = () =>
      id(
        tx,
        sql`INSERT INTO tokens (symbol, name, type_id) VALUES (concat('SHADOW', gen_random_uuid()), 'shadow', ${tokenTypeId}) RETURNING id`
      );
    const heldTokenId = await token();
    const tokenId = await token();
    const baseTokenId = await token();
    const holdingId = await id(
      tx,
      sql`INSERT INTO holdings (user_id, account_id, token_id, balance) VALUES (${userId}, ${accountId}, ${heldTokenId}, '1') RETURNING id`
    );
    const runId = await id(tx, insertRun('balance', 'complete'));
    const differenceId = await id(
      tx,
      sql`INSERT INTO engine_shadow_differences (run_id, user_id, holding_id, token_id, base_token_id, at, comparator, category)
          VALUES (${runId}, ${userId}, ${holdingId}, ${tokenId}, ${baseTokenId}, now(), 'stored-balance', 'unexplained') RETURNING id`
    );
    expect(
      await refusedWith(
        tx,
        sql`INSERT INTO engine_shadow_differences (run_id, holding_id, at, comparator, category)
            VALUES (${runId}, ${holdingId}, now(), 'stored-balance', 'unexplained')`
      )
    ).toBe('23514');
    const priceDifferenceId = await id(
      tx,
      sql`INSERT INTO engine_shadow_differences (run_id, token_id, base_token_id, at, comparator, category)
          VALUES (${runId}, ${tokenId}, ${baseTokenId}, now(), 'live-resolver', 'route') RETURNING id`
    );
    const references = () =>
      one<{ holding_id: string | null; token_id: string | null; base_token_id: string | null }>(
        tx,
        sql`SELECT holding_id, token_id, base_token_id FROM engine_shadow_differences WHERE id = ${differenceId}`
      );

    await tx.execute(sql`DELETE FROM holdings WHERE id = ${holdingId}`);
    await tx.execute(sql`DELETE FROM tokens WHERE id IN (${tokenId}, ${baseTokenId})`);
    expect(await references()).toEqual({ holding_id: null, token_id: null, base_token_id: null });

    await tx.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    const left = await one<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM engine_shadow_differences WHERE id IN (${differenceId}, ${priceDifferenceId})`
    );
    expect(left.n).toBe(1);
  });
});
