import { expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { inRollback, type Query, refusedWith, type Tx } from './foundation-helpers';

/**
 * A fetch records at most one window. A replayed fetch — a retried job, a
 * double-submitted upload — carries the same input, range and fetch instant,
 * and without the index it would add a second row for the same fetch. An open
 * start (`from_at` NULL) is a value here, not an unknown: two windows that are
 * both unbounded at the start are the same window.
 *
 * Every test runs inside a transaction that is rolled back, and an expected
 * failure runs in a savepoint of its own (see `refusedWith`).
 */

const id = async (tx: Tx, query: Query) => {
  const [row] = (await tx.execute(query)) as unknown as { id: string }[];
  if (!row) throw new Error('query returned no row');
  return row.id;
};

async function seedInput(tx: Tx): Promise<string> {
  const userId = await id(
    tx,
    sql`INSERT INTO users (email, name) VALUES (concat('feed-windows-', gen_random_uuid(), '@example.test'), 'windows') RETURNING id`
  );
  const institutionId = await id(
    tx,
    sql`INSERT INTO institutions (name, type_id) VALUES (concat('windows-', gen_random_uuid()), (SELECT id FROM institution_types LIMIT 1)) RETURNING id`
  );
  const accountId = await id(
    tx,
    sql`INSERT INTO accounts (user_id, institution_id, name, type_id) VALUES (${userId}, ${institutionId}, concat('acct-', gen_random_uuid()), (SELECT id FROM account_types LIMIT 1)) RETURNING id`
  );
  return id(
    tx,
    sql`INSERT INTO feed_inputs (user_id, account_id, source) VALUES (${userId}, ${accountId}, 'kraken-api') RETURNING id`
  );
}

const insertWindow = (
  inputId: string,
  fromAt: string | null,
  toAt: string,
  fetchedAt: string
): Query =>
  sql`INSERT INTO feed_input_windows (input_id, from_at, to_at, complete, fetched_at)
      VALUES (${inputId}, ${fromAt}::timestamptz, ${toAt}::timestamptz, true, ${fetchedAt}::timestamptz)`;

test('a second window with the same (input, from, to, fetched_at) is refused with 23505', async () => {
  await inRollback(async (tx) => {
    const inputId = await seedInput(tx);
    const window = () => insertWindow(inputId, '2026-01-01', '2026-01-31', '2026-02-01T00:00:00Z');
    await tx.execute(window());

    expect(await refusedWith(tx, window())).toBe('23505');
  });
});

test('a NULL from_at counts as equal', async () => {
  await inRollback(async (tx) => {
    const inputId = await seedInput(tx);
    const window = () => insertWindow(inputId, null, '2026-01-31', '2026-02-01T00:00:00Z');
    await tx.execute(window());

    expect(await refusedWith(tx, window())).toBe('23505');
  });
});

test('a different fetched_at is accepted', async () => {
  await inRollback(async (tx) => {
    const inputId = await seedInput(tx);
    await tx.execute(insertWindow(inputId, null, '2026-01-31', '2026-02-01T00:00:00Z'));

    expect(
      await refusedWith(tx, insertWindow(inputId, null, '2026-01-31', '2026-02-02T00:00:00Z'))
    ).toBe(undefined);
  });
});

// The controls below vary one column of the key at a time, so an index on
// fewer columns than the key refuses one of them.

test('a different to_at is accepted', async () => {
  await inRollback(async (tx) => {
    const inputId = await seedInput(tx);
    await tx.execute(insertWindow(inputId, '2026-01-01', '2026-01-31', '2026-02-01T00:00:00Z'));

    expect(
      await refusedWith(
        tx,
        insertWindow(inputId, '2026-01-01', '2026-02-28', '2026-02-01T00:00:00Z')
      )
    ).toBe(undefined);
  });
});

test('a different from_at is accepted, an open start included', async () => {
  await inRollback(async (tx) => {
    const inputId = await seedInput(tx);
    await tx.execute(insertWindow(inputId, '2026-01-01', '2026-01-31', '2026-02-01T00:00:00Z'));

    expect(
      await refusedWith(
        tx,
        insertWindow(inputId, '2026-01-15', '2026-01-31', '2026-02-01T00:00:00Z')
      )
    ).toBe(undefined);
    expect(
      await refusedWith(tx, insertWindow(inputId, null, '2026-01-31', '2026-02-01T00:00:00Z'))
    ).toBe(undefined);
  });
});

test('a different input is accepted', async () => {
  await inRollback(async (tx) => {
    const first = await seedInput(tx);
    const second = await seedInput(tx);
    await tx.execute(insertWindow(first, null, '2026-01-31', '2026-02-01T00:00:00Z'));

    expect(
      await refusedWith(tx, insertWindow(second, null, '2026-01-31', '2026-02-01T00:00:00Z'))
    ).toBe(undefined);
  });
});
