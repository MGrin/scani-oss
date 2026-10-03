import { expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { inRollback, refusal, type Tx } from './foundation-helpers';

/**
 * The trigger that will stop anything but the engine calculator writing
 * `holdings.balance`, `value_base` and `value_priced_at` (plan A5 enables it).
 * Foundation A1 creates it DISABLED, so what is pinned here is two things: on
 * the real table it changes nothing, and attached to a scratch copy of
 * `holdings` it refuses exactly what the spec says it refuses.
 *
 * The scratch copy is a temp table, so the real `holdings` is never guarded
 * and never locked by the part of this file that enables a trigger. Every test
 * runs in a transaction that is rolled back, and an expected refusal runs in a
 * savepoint of its own (see `foundation-helpers.ts`).
 */

const refused = (column: string) => ({
  code: 'SCE01',
  message: `holdings.${column} is written only by the engine calculator`,
});

async function attachProbe(tx: Tx): Promise<void> {
  await tx.execute(
    sql`CREATE TEMP TABLE holdings_guard_probe (LIKE holdings INCLUDING DEFAULTS) ON COMMIT DROP`
  );
  await tx.execute(
    sql`CREATE TRIGGER holdings_guard_probe_guard BEFORE INSERT OR UPDATE ON holdings_guard_probe
        FOR EACH ROW EXECUTE FUNCTION holdings_engine_writer_guard()`
  );
}

const insertProbe = (balance: string, extra: { column: string; value: string } | null = null) =>
  sql`INSERT INTO holdings_guard_probe (user_id, account_id, token_id, balance${
    extra ? sql.raw(`, ${extra.column}`) : sql``
  })
      VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), ${balance}${
        extra ? sql.raw(`, ${extra.value}`) : sql``
      })`;

/** An empty probe holding: balance '0' and nothing else the guard watches. */
async function seedProbe(tx: Tx): Promise<void> {
  await attachProbe(tx);
  await tx.execute(insertProbe('0'));
}

const engine = (tx: Tx) =>
  tx.execute(sql`SELECT set_config('scani.engine_writer', 'calculator', true)`);

const probeBalance = async (tx: Tx) =>
  (
    (await tx.execute(sql`SELECT balance FROM holdings_guard_probe`)) as unknown as {
      balance: string;
    }[]
  )[0]?.balance;

test('the trigger exists on holdings, fires before an insert or update of a row, and is disabled', async () => {
  await inRollback(async (tx) => {
    const [trigger] = (await tx.execute(
      sql`SELECT tgenabled, pg_get_triggerdef(oid) AS definition
          FROM pg_trigger
          WHERE tgname = 'holdings_engine_writer_guard' AND tgrelid = 'holdings'::regclass`
    )) as unknown as { tgenabled: string; definition: string }[];

    expect(trigger?.tgenabled).toBe('D');
    expect(trigger?.definition).toContain('BEFORE INSERT OR UPDATE ON');
    expect(trigger?.definition).toContain('FOR EACH ROW');
    expect(trigger?.definition).toContain('EXECUTE FUNCTION holdings_engine_writer_guard()');
  });
});

test('disabled means A1 changes nothing: a funded insert and a direct balance UPDATE on holdings succeed', async () => {
  await inRollback(async (tx) => {
    const one = async (query: ReturnType<typeof sql>) =>
      ((await tx.execute(query)) as unknown as { id: string }[])[0]?.id;
    const userId = await one(
      sql`INSERT INTO users (email, name) VALUES (concat('engine-guard-', gen_random_uuid(), '@example.test'), 'guard') RETURNING id`
    );
    const institutionId = await one(
      sql`INSERT INTO institutions (name, type_id) VALUES (concat('guard-', gen_random_uuid()), (SELECT id FROM institution_types LIMIT 1)) RETURNING id`
    );
    const accountId = await one(
      sql`INSERT INTO accounts (user_id, institution_id, name, type_id) VALUES (${userId}, ${institutionId}, concat('acct-', gen_random_uuid()), (SELECT id FROM account_types LIMIT 1)) RETURNING id`
    );
    const tokenId = await one(
      sql`INSERT INTO tokens (symbol, name, type_id) VALUES (concat('EG', substr(gen_random_uuid()::text, 1, 8)), 'guard token', (SELECT id FROM token_types LIMIT 1)) RETURNING id`
    );

    const holdingId = await one(
      sql`INSERT INTO holdings (user_id, account_id, token_id, balance) VALUES (${userId}, ${accountId}, ${tokenId}, '10') RETURNING id`
    );
    const [updated] = (await tx.execute(
      sql`UPDATE holdings SET balance = '11', value_base = '1', value_priced_at = now()
          WHERE id = ${holdingId}
          RETURNING balance, value_base`
    )) as unknown as { balance: string; value_base: string }[];

    expect(updated).toEqual({ balance: '11', value_base: '1' });
  });
});

test('a balance UPDATE outside the engine is refused', async () => {
  await inRollback(async (tx) => {
    await seedProbe(tx);

    expect(await refusal(tx, sql`UPDATE holdings_guard_probe SET balance = '10'`)).toEqual(
      refused('balance')
    );
    expect(await probeBalance(tx)).toBe('0');
  });
});

test('CONTROL: the same UPDATE succeeds once the transaction set scani.engine_writer = calculator', async () => {
  await inRollback(async (tx) => {
    await seedProbe(tx);
    const update = sql`UPDATE holdings_guard_probe SET balance = '10'`;

    expect(await refusal(tx, update)).toEqual(refused('balance'));
    await engine(tx);
    expect(await refusal(tx, update)).toBeUndefined();
    expect(await probeBalance(tx)).toBe('10');
  });
});

test('only the word calculator opens the guard', async () => {
  await inRollback(async (tx) => {
    await seedProbe(tx);
    await tx.execute(sql`SELECT set_config('scani.engine_writer', 'importer', true)`);

    expect(await refusal(tx, sql`UPDATE holdings_guard_probe SET balance = '10'`)).toEqual(
      refused('balance')
    );
  });
});

test('a write to any other column needs no GUC, and neither does one that leaves the guarded columns as they were', async () => {
  await inRollback(async (tx) => {
    await seedProbe(tx);

    expect(
      await refusal(tx, sql`UPDATE holdings_guard_probe SET is_hidden = true, label = 'Savings'`)
    ).toBeUndefined();
    expect(
      await refusal(
        tx,
        sql`UPDATE holdings_guard_probe SET balance = balance, value_base = value_base, value_priced_at = value_priced_at, is_active = false`
      )
    ).toBeUndefined();
  });
});

test('an insert with an empty cache needs no GUC; a funded one is refused', async () => {
  await inRollback(async (tx) => {
    await attachProbe(tx);

    expect(await refusal(tx, insertProbe('0'))).toBeUndefined();
    expect(await refusal(tx, insertProbe('5'))).toEqual(refused('balance'));
  });
});

test('value_base is guarded like balance, on insert and on update', async () => {
  await inRollback(async (tx) => {
    await seedProbe(tx);

    expect(await refusal(tx, sql`UPDATE holdings_guard_probe SET value_base = '1'`)).toEqual(
      refused('value_base')
    );
    expect(await refusal(tx, insertProbe('0', { column: 'value_base', value: `'1'` }))).toEqual(
      refused('value_base')
    );

    await engine(tx);
    expect(
      await refusal(tx, sql`UPDATE holdings_guard_probe SET value_base = '1'`)
    ).toBeUndefined();
  });
});

test('value_priced_at is guarded under its own name, on insert and on update', async () => {
  await inRollback(async (tx) => {
    await seedProbe(tx);

    expect(await refusal(tx, sql`UPDATE holdings_guard_probe SET value_priced_at = now()`)).toEqual(
      refused('value_priced_at')
    );
    expect(
      await refusal(tx, insertProbe('0', { column: 'value_priced_at', value: 'now()' }))
    ).toEqual(refused('value_priced_at'));

    await engine(tx);
    expect(
      await refusal(tx, sql`UPDATE holdings_guard_probe SET value_priced_at = now()`)
    ).toBeUndefined();
  });
});
