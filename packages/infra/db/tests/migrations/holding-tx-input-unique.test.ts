import { expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { inRollback, type Query, refusal, type Tx } from './foundation-helpers';

/**
 * A ledger entry is unique per input (foundation A2 D-7, Task 13): one feed
 * input states an external id once, whichever holding the entry sits in. The
 * old key, `holding_tx_dedup` on (holding, source, external_id), let one event
 * land twice when a re-import resolved it to a second holding. Person and
 * system rows carry no input, so a NULL input is exempt.
 *
 * Every test runs inside a transaction that is rolled back, and an expected
 * failure runs in a savepoint of its own (see `refusal`).
 */

async function rows<T>(tx: Tx, query: Query): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[];
}

const id = async (tx: Tx, query: Query) => {
  const [row] = await rows<{ id: string }>(tx, query);
  if (!row) throw new Error('query returned no row');
  return row.id;
};

interface Seed {
  userId: string;
  accountId: string;
  tokenId: string;
  holdingIds: [string, string];
  inputIds: [string, string];
}

/** One account holding one token twice, fed by two inputs. */
async function seed(tx: Tx): Promise<Seed> {
  const userId = await id(
    tx,
    sql`INSERT INTO users (email, name) VALUES (concat('input-key-', gen_random_uuid(), '@example.test'), 'input key') RETURNING id`
  );
  const institutionId = await id(
    tx,
    sql`INSERT INTO institutions (name, type_id) VALUES (concat('input-key-', gen_random_uuid()), (SELECT id FROM institution_types LIMIT 1)) RETURNING id`
  );
  const accountId = await id(
    tx,
    sql`INSERT INTO accounts (user_id, institution_id, name, type_id) VALUES (${userId}, ${institutionId}, concat('acct-', gen_random_uuid()), (SELECT id FROM account_types LIMIT 1)) RETURNING id`
  );
  const tokenId = await id(
    tx,
    sql`INSERT INTO tokens (symbol, name, type_id) VALUES (concat('IK', substr(gen_random_uuid()::text, 1, 8)), 'input key token', (SELECT id FROM token_types LIMIT 1)) RETURNING id`
  );
  const holding = () =>
    id(
      tx,
      sql`INSERT INTO holdings (user_id, account_id, token_id, balance) VALUES (${userId}, ${accountId}, ${tokenId}, '0') RETURNING id`
    );
  const input = (source: string) =>
    id(
      tx,
      sql`INSERT INTO feed_inputs (user_id, account_id, source) VALUES (${userId}, ${accountId}, ${source}) RETURNING id`
    );
  return {
    userId,
    accountId,
    tokenId,
    holdingIds: [await holding(), await holding()],
    inputIds: [await input('kraken-api'), await input('statement')],
  };
}

const entry = (
  s: Seed,
  holdingId: string,
  inputId: string | null,
  externalId: string,
  source = 'kraken-api'
): Query =>
  sql`INSERT INTO holding_transactions (user_id, holding_id, token_id, kind, quantity, occurred_at, external_id, source, input_id)
      VALUES (${s.userId}, ${holdingId}, ${s.tokenId}, 'deposit', '1', now(), ${externalId}, ${source}, ${inputId}::uuid)`;

test('a second row with the same (input, external_id) is refused, whichever holding it sits in', async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    const [first, second] = s.holdingIds;
    await tx.execute(entry(s, first, s.inputIds[0], 'ledger-1'));

    const refused = await refusal(tx, entry(s, second, s.inputIds[0], 'ledger-1'));

    expect(refused?.code).toBe('23505');
    expect(refused?.message).toContain('holding_tx_input_external_uq');
  });
});

test('NULL inputs are exempt: person and system rows may share an external id across holdings', async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    const [first, second] = s.holdingIds;
    await tx.execute(entry(s, first, null, 'typed-1', 'user-balance-edit'));

    expect(await refusal(tx, entry(s, second, null, 'typed-1', 'user-balance-edit'))).toBe(
      undefined
    );
  });
});

// The controls vary one column of the key at a time, so a key on fewer
// columns than (input_id, external_id) refuses one of them.

test('another external id on the same input is accepted', async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    const [first, second] = s.holdingIds;
    await tx.execute(entry(s, first, s.inputIds[0], 'ledger-1'));

    expect(await refusal(tx, entry(s, second, s.inputIds[0], 'ledger-2'))).toBe(undefined);
  });
});

test('the same external id on another input is accepted', async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    const [first, second] = s.holdingIds;
    await tx.execute(entry(s, first, s.inputIds[0], 'ledger-1'));

    expect(await refusal(tx, entry(s, second, s.inputIds[1], 'ledger-1'))).toBe(undefined);
  });
});

// A1 carry-forward 7: the unique key leads on input_id, so it is the index a
// deleted input's ON DELETE SET NULL walks, and the partial one goes.
test('the key replaces idx_holding_tx_input_id as the index on input_id', async () => {
  await inRollback(async (tx) => {
    const indexes = await rows<{ indexname: string; indexdef: string }>(
      tx,
      sql`SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'holding_transactions'
            AND indexname IN ('idx_holding_tx_input_id', 'holding_tx_input_external_uq')`
    );
    const constraints = await rows<{ conname: string; contype: string }>(
      tx,
      sql`SELECT conname, contype FROM pg_constraint
          WHERE conrelid = 'holding_transactions'::regclass AND conname = 'holding_tx_input_external_uq'`
    );

    expect(indexes.map((i) => i.indexname)).toEqual(['holding_tx_input_external_uq']);
    expect(indexes[0]?.indexdef).toEndWith('USING btree (input_id, external_id)');
    expect(constraints).toEqual([{ conname: 'holding_tx_input_external_uq', contype: 'u' }]);
  });
});

/**
 * R53 asked this migration for an index on the reads
 * `HoldingBalanceObservationRepository.findLatestAtOrAfter` and
 * `findLatestAtOrBefore`: one holding, `observed_at` bounded on one side,
 * ordered by `observed_at`, the first row. An index that leads on exactly
 * (holding_id, observed_at) serves both, walked forward or backward, with both
 * conditions in its bound and no sort, and the table already has one. So the
 * migration adds none.
 *
 * This reads the catalog, not a plan. Which index the planner picks follows
 * the table's stats, and those are whatever earlier files in the run left: on
 * one CI shard it took a bitmap scan, on another an index in a different
 * column order plus a sort, each a red with nothing wrong in the schema.
 */
test('the observation reads R53 named already have an index leading on (holding_id, observed_at)', async () => {
  await inRollback(async (tx) => {
    const indexes = await rows<{ index: string; first: string; second: string | null }>(
      tx,
      sql`SELECT i.relname AS index,
                 (SELECT attname::text FROM pg_attribute
                   WHERE attrelid = x.indrelid AND attnum = x.indkey[0]) AS first,
                 (SELECT attname::text FROM pg_attribute
                   WHERE attrelid = x.indrelid AND attnum = x.indkey[1]) AS second
          FROM pg_index x
          JOIN pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = 'holding_balance_observations'::regclass
            AND x.indpred IS NULL AND x.indisvalid`
    );
    const leadingOn = (first: string, second: string) =>
      indexes.filter((i) => i.first === first && i.second === second).map((i) => i.index);

    expect(leadingOn('holding_id', 'observed_at')).not.toEqual([]);
    // The lookup tells column orders apart: these two lead elsewhere.
    expect(leadingOn('user_id', 'observed_at')).toEqual(['idx_holding_obs_user_observed']);
    expect(leadingOn('observed_at', 'holding_id')).toEqual([]);
  });
});
