import { expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { inRollback, refusedWith, type Tx } from './foundation-helpers';

/**
 * The five tables foundation A1 adds: feed inputs and their windows, match
 * rules, judgment decisions and the outbox. Nothing reads them yet, so what is
 * worth pinning is the shape the later plans lean on — the uniqueness that
 * keeps an input to one row per (account, source), the vocabularies the
 * CHECKs hold to the spec's words, and the cascade that takes an input with
 * its account.
 *
 * Every test runs inside a transaction that is rolled back. An expected
 * failure runs in a savepoint of its own: a failed statement aborts the whole
 * transaction in Postgres, so without one the next statement would fail for
 * that reason and not the one under test.
 */

async function rows<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[];
}

async function one<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T> {
  const [row] = await rows<T>(tx, query);
  if (!row) throw new Error('query returned no row');
  return row;
}

const id = (tx: Tx, query: ReturnType<typeof sql>) =>
  one<{ id: string }>(tx, query).then((r) => r.id);

async function seedAccount(tx: Tx): Promise<{ userId: string; accountId: string }> {
  const userId = await id(
    tx,
    sql`INSERT INTO users (email, name) VALUES (concat('foundation-feeds-', gen_random_uuid(), '@example.test'), 'feeds') RETURNING id`
  );
  const institutionId = await id(
    tx,
    sql`INSERT INTO institutions (name, type_id) VALUES (concat('feeds-', gen_random_uuid()), (SELECT id FROM institution_types LIMIT 1)) RETURNING id`
  );
  const accountId = await id(
    tx,
    sql`INSERT INTO accounts (user_id, institution_id, name, type_id) VALUES (${userId}, ${institutionId}, concat('acct-', gen_random_uuid()), (SELECT id FROM account_types LIMIT 1)) RETURNING id`
  );
  return { userId, accountId };
}

const insertInput = (userId: string, accountId: string, source: string, status = 'active') =>
  sql`INSERT INTO feed_inputs (user_id, account_id, source, status) VALUES (${userId}, ${accountId}, ${source}, ${status}) RETURNING id`;

test('feed_inputs is unique per (account, source)', async () => {
  await inRollback(async (tx) => {
    const { userId, accountId } = await seedAccount(tx);
    await tx.execute(insertInput(userId, accountId, 'kraken-api'));

    expect(await refusedWith(tx, insertInput(userId, accountId, 'kraken-api'))).toBe('23505');
    expect(await refusedWith(tx, insertInput(userId, accountId, 'kraken-statement'))).toBe(
      undefined
    );
  });
});

test('feed_inputs.status refuses anything but active or disconnected', async () => {
  await inRollback(async (tx) => {
    const { userId, accountId } = await seedAccount(tx);

    expect(await refusedWith(tx, insertInput(userId, accountId, 'paused-source', 'paused'))).toBe(
      '23514'
    );
    expect(
      await refusedWith(tx, insertInput(userId, accountId, 'gone-source', 'disconnected'))
    ).toBe(undefined);
  });
});

test('a window may have an open start', async () => {
  await inRollback(async (tx) => {
    const { userId, accountId } = await seedAccount(tx);
    const inputId = await id(tx, insertInput(userId, accountId, 'kraken-api'));

    const window = await one<{ from_at: Date | null; complete: boolean }>(
      tx,
      sql`INSERT INTO feed_input_windows (input_id, from_at, to_at, complete, fetched_at)
          VALUES (${inputId}, NULL, '2026-01-31', false, now())
          RETURNING from_at, complete`
    );

    expect(window).toEqual({ from_at: null, complete: false });
  });
});

test('judgment_decisions.applied is the spec vocabulary', async () => {
  await inRollback(async (tx) => {
    const { userId } = await seedAccount(tx);
    const decision = (key: string, applied: string) =>
      sql`INSERT INTO judgment_decisions (user_id, question_key, question_version, state_hash, model_id, answer, probabilities, applied)
          VALUES (${userId}, ${key}, 1, 'h', 'jev-1', 'yes', '{"yes": 0.9, "no": 0.1}'::jsonb, ${applied})`;

    for (const applied of ['auto', 'proposed', 'confirmed', 'overridden', 'rejected']) {
      await tx.execute(decision(`q-${applied}`, applied));
    }
    const stored = await rows<{ applied: string }>(
      tx,
      sql`SELECT applied FROM judgment_decisions WHERE user_id = ${userId} ORDER BY applied`
    );
    expect(stored.map((r) => r.applied)).toEqual([
      'auto',
      'confirmed',
      'overridden',
      'proposed',
      'rejected',
    ]);

    expect(await refusedWith(tx, decision('q-maybe', 'maybe'))).toBe('23514');
  });
});

test('a match rule names a destination or a kind', async () => {
  await inRollback(async (tx) => {
    const { userId, accountId } = await seedAccount(tx);
    const inputId = await id(tx, insertInput(userId, accountId, 'kraken-api'));
    const rule = (pattern: string, destination: string | null, kind: string | null) =>
      sql`INSERT INTO feed_match_rules (user_id, input_id, match_field, pattern, destination_account_id, ledger_kind, created_by)
          VALUES (${userId}, ${inputId}, 'description', ${pattern}, ${destination}::uuid, ${kind}, 'person')`;

    expect(await refusedWith(tx, rule('names neither', null, null))).toBe('23514');
    expect(await refusedWith(tx, rule('names a destination', accountId, null))).toBe(undefined);
    expect(await refusedWith(tx, rule('names a kind', null, 'income'))).toBe(undefined);
  });
});

test('outbox ids increase', async () => {
  await inRollback(async (tx) => {
    const insert = sql`INSERT INTO outbox_events (type, payload) VALUES ('price.updated', '{}'::jsonb) RETURNING id`;
    const first = await one<{ id: string | number }>(tx, insert);
    const second = await one<{ id: string | number }>(tx, insert);

    expect(BigInt(second.id)).toBeGreaterThan(BigInt(first.id));
  });
});

test('deleting the account removes its inputs and their windows', async () => {
  await inRollback(async (tx) => {
    const { userId, accountId } = await seedAccount(tx);
    const inputId = await id(tx, insertInput(userId, accountId, 'kraken-api'));
    await tx.execute(
      sql`INSERT INTO feed_input_windows (input_id, from_at, to_at, complete, fetched_at)
          VALUES (${inputId}, '2026-01-01', '2026-01-31', true, now())`
    );

    await tx.execute(sql`DELETE FROM accounts WHERE id = ${accountId}`);

    const inputs = await one<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM feed_inputs WHERE id = ${inputId}`
    );
    const windows = await one<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM feed_input_windows WHERE input_id = ${inputId}`
    );
    expect(inputs.n).toBe(0);
    expect(windows.n).toBe(0);
  });
});
