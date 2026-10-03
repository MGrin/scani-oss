import { expect, test } from 'bun:test';
import { getTableColumns, sql } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/schema';
import { inRollback, type Query, refusedWith, type Tx } from './foundation-helpers';

/**
 * The evidence columns foundation A1 adds to `holdings`,
 * `holding_balance_observations` and `holding_transactions`. Nothing reads or
 * writes them yet, so what is worth pinning is the promise made to everything
 * that already does: a writer that has never heard of them is unaffected, the
 * vocabularies are the spec's words, a pointer at deleted evidence clears
 * instead of blocking the delete, and a row captured by `to_jsonb` before the
 * columns existed still comes back through the restore shape
 * `SettlementAnswerReviewService.restoreRows` uses.
 *
 * Every test runs inside a transaction that is rolled back. An expected
 * failure runs in a savepoint of its own: a failed statement aborts the whole
 * transaction in Postgres, so without one the next statement would fail for
 * that reason and not the one under test.
 */

async function rows<T>(tx: Tx, query: Query): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[];
}

async function one<T>(tx: Tx, query: Query): Promise<T> {
  const [row] = await rows<T>(tx, query);
  if (!row) throw new Error('query returned no row');
  return row;
}

const id = (tx: Tx, query: Query) => one<{ id: string }>(tx, query).then((r) => r.id);

interface Seed {
  userId: string;
  accountId: string;
  tokenId: string;
  holdingId: string;
}

async function seedHolding(tx: Tx): Promise<Seed> {
  const userId = await id(
    tx,
    sql`INSERT INTO users (email, name) VALUES (concat('foundation-evidence-', gen_random_uuid(), '@example.test'), 'evidence') RETURNING id`
  );
  const institutionId = await id(
    tx,
    sql`INSERT INTO institutions (name, type_id) VALUES (concat('evidence-', gen_random_uuid()), (SELECT id FROM institution_types LIMIT 1)) RETURNING id`
  );
  const accountId = await id(
    tx,
    sql`INSERT INTO accounts (user_id, institution_id, name, type_id) VALUES (${userId}, ${institutionId}, concat('acct-', gen_random_uuid()), (SELECT id FROM account_types LIMIT 1)) RETURNING id`
  );
  const tokenId = await seedToken(tx);
  const holdingId = await id(
    tx,
    sql`INSERT INTO holdings (user_id, account_id, token_id, balance) VALUES (${userId}, ${accountId}, ${tokenId}, '10') RETURNING id`
  );
  return { userId, accountId, tokenId, holdingId };
}

const seedToken = (tx: Tx) =>
  id(
    tx,
    sql`INSERT INTO tokens (symbol, name, type_id) VALUES (concat('EV', substr(gen_random_uuid()::text, 1, 8)), 'evidence token', (SELECT id FROM token_types LIMIT 1)) RETURNING id`
  );

let sequence = 0;

const insertObservation = (seed: Seed, columns: Query = sql``, values: Query = sql``) =>
  sql`INSERT INTO holding_balance_observations (user_id, holding_id, balance, observed_at, source${columns})
      VALUES (${seed.userId}, ${seed.holdingId}, '10', now() + make_interval(secs => ${++sequence}::double precision), 'sync-capture'${values})
      RETURNING id`;

const insertLedgerRow = (seed: Seed, columns: Query = sql``, values: Query = sql``) =>
  sql`INSERT INTO holding_transactions (user_id, holding_id, token_id, kind, quantity, occurred_at, external_id, source${columns})
      VALUES (${seed.userId}, ${seed.holdingId}, ${seed.tokenId}, 'deposit', '5', now(), concat('evidence-', ${++sequence}::text), 'statement-csv'${values})
      RETURNING id`;

const insertInput = (seed: Seed) =>
  sql`INSERT INTO feed_inputs (user_id, account_id, source) VALUES (${seed.userId}, ${seed.accountId}, concat('src-', gen_random_uuid())) RETURNING id`;

const insertDecision = (seed: Seed) =>
  sql`INSERT INTO judgment_decisions (user_id, question_key, question_version, state_hash, model_id, answer, probabilities, applied)
      VALUES (${seed.userId}, concat('q-', gen_random_uuid()), 1, 'h', 'jev-1', 'yes', '{"yes": 0.9}'::jsonb, 'auto')
      RETURNING id`;

const NEW_COLUMNS: Record<string, string[]> = {
  holdings: ['kind', 'starts_at', 'value_base', 'value_priced_at'],
  holding_balance_observations: ['role', 'authority', 'input_id', 'cause', 'superseded_at'],
  holding_transactions: [
    'ledger_kind',
    'kind_subtype',
    'group_id',
    'fee_of',
    'input_id',
    'execution_price',
    'execution_price_token_id',
    'kind_origin',
    'decision_id',
  ],
};

/** For each new column of `table`, whether it reads NULL on the row. */
const readNulls = (tx: Tx, table: string, rowId: string) =>
  one<Record<string, boolean>>(
    tx,
    sql.raw(
      `SELECT ${(NEW_COLUMNS[table] ?? []).map((c) => `${c} IS NULL AS ${c}`).join(', ')} FROM ${table} WHERE id = '${rowId}'`
    )
  );

const allNull = (table: string) =>
  Object.fromEntries((NEW_COLUMNS[table] ?? []).map((c) => [c, true]));

/** The statement shape `SettlementAnswerReviewService.restoreRows` runs. */
function restoreStatement(table: PgTable, captured: Record<string, unknown>[]): Query {
  const name = sql.identifier(getTableConfig(table).name);
  const columns = sql.join(
    Object.values(getTableColumns(table))
      .filter((column) => !column.generated)
      .map((column) => sql.identifier(column.name)),
    sql`, `
  );
  return sql`
    INSERT INTO ${name} (${columns})
    SELECT ${columns} FROM jsonb_populate_recordset(NULL::${name}, ${JSON.stringify(captured)}::jsonb)
  `;
}

/** `to_jsonb` of a row, with the named keys removed: the row as it was captured before they existed. */
const capturedBefore = (tx: Tx, table: string, rowId: string, absent: string[]) =>
  one<{ captured: Record<string, unknown> }>(
    tx,
    sql.raw(
      `SELECT to_jsonb(t)${absent.map((c) => ` - '${c}'`).join('')} AS captured FROM ${table} t WHERE id = '${rowId}'`
    )
  ).then((r) => r.captured);

test("today's writers are unaffected: a holding, an observation and a ledger row insert without the new columns", async () => {
  await inRollback(async (tx) => {
    const seed = await seedHolding(tx);
    const observationId = await id(tx, insertObservation(seed));
    const ledgerId = await id(tx, insertLedgerRow(seed));

    expect(await readNulls(tx, 'holdings', seed.holdingId)).toEqual(allNull('holdings'));
    expect(await readNulls(tx, 'holding_balance_observations', observationId)).toEqual(
      allNull('holding_balance_observations')
    );
    expect(await readNulls(tx, 'holding_transactions', ledgerId)).toEqual(
      allNull('holding_transactions')
    );
  });
});

test('the new vocabularies are enforced on write', async () => {
  await inRollback(async (tx) => {
    const seed = await seedHolding(tx);
    const setHolding = (kind: string) =>
      sql`UPDATE holdings SET kind = ${kind} WHERE id = ${seed.holdingId}`;

    expect(await refusedWith(tx, setHolding('mixed'))).toBe('23514');
    expect(await refusedWith(tx, setHolding('feed'))).toBeUndefined();

    expect(await refusedWith(tx, insertObservation(seed, sql`, role`, sql`, 'anchor'`))).toBe(
      '23514'
    );
    expect(
      await refusedWith(tx, insertObservation(seed, sql`, role`, sql`, 'checkpoint'`))
    ).toBeUndefined();
    expect(await refusedWith(tx, insertObservation(seed, sql`, cause`, sql`, 'drift'`))).toBe(
      '23514'
    );
    expect(
      await refusedWith(tx, insertObservation(seed, sql`, cause`, sql`, 'growth'`))
    ).toBeUndefined();

    // ledger_kind is pinned against the engine's own list in EngineEvidenceRepository.test.ts.
    expect(await refusedWith(tx, insertLedgerRow(seed, sql`, kind_origin`, sql`, 'ai'`))).toBe(
      '23514'
    );
    expect(
      await refusedWith(tx, insertLedgerRow(seed, sql`, kind_origin`, sql`, 'mirror'`))
    ).toBeUndefined();
  });
});

test("every word of the spec's vocabularies is accepted, and a near miss is not", async () => {
  await inRollback(async (tx) => {
    const seed = await seedHolding(tx);
    const vocabularies = [
      ['holdings', 'kind', ['snapshot', 'feed']],
      ['observations', 'role', ['snapshot', 'checkpoint', 'verification']],
      ['observations', 'authority', ['provider', 'statement', 'person']],
      ['observations', 'cause', ['flow', 'growth', 'correction']],
      [
        'ledger',
        'ledger_kind',
        [
          'inflow',
          'outflow',
          'transfer_in',
          'transfer_out',
          'trade_leg',
          'fee',
          'income',
          'corporate_action',
          'derivative_pnl',
          'unexplained_difference',
        ],
      ],
      ['ledger', 'kind_subtype', ['interest', 'staking', 'dividend', 'apy', 'airdrop', 'reward']],
      ['ledger', 'kind_origin', ['source', 'rule', 'jev', 'person', 'mirror']],
    ] as const;

    for (const [table, column, words] of vocabularies) {
      const write = (word: string) =>
        table === 'holdings'
          ? sql`UPDATE holdings SET kind = ${word} WHERE id = ${seed.holdingId}`
          : table === 'observations'
            ? insertObservation(seed, sql.raw(`, ${column}`), sql`, ${word}`)
            : insertLedgerRow(seed, sql.raw(`, ${column}`), sql`, ${word}`);
      for (const word of words) {
        expect([column, word, await refusedWith(tx, write(word))]).toEqual([
          column,
          word,
          undefined,
        ]);
      }
      expect([column, await refusedWith(tx, write(`${words[0]} `))]).toEqual([column, '23514']);
    }
  });
});

test('REVIEW FOCUS 1: a holdings row captured before this migration restores', async () => {
  await inRollback(async (tx) => {
    const seed = await seedHolding(tx);
    const captured = await capturedBefore(
      tx,
      'holdings',
      seed.holdingId,
      NEW_COLUMNS.holdings ?? []
    );
    expect(Object.keys(captured)).not.toContain('kind');
    await tx.execute(sql`DELETE FROM holdings WHERE id = ${seed.holdingId}`);

    await tx.execute(restoreStatement(schema.holdings, [captured]));

    const restored = await one<{ balance: string; kind: string | null; starts_at: Date | null }>(
      tx,
      sql`SELECT balance, kind, starts_at FROM holdings WHERE id = ${seed.holdingId}`
    );
    expect(restored).toEqual({ balance: '10', kind: null, starts_at: null });
  });
});

test('REVIEW FOCUS 1: an observation and a ledger row captured before this migration restore', async () => {
  await inRollback(async (tx) => {
    const seed = await seedHolding(tx);
    const observationId = await id(tx, insertObservation(seed));
    const ledgerId = await id(tx, insertLedgerRow(seed));
    const observation = await capturedBefore(
      tx,
      'holding_balance_observations',
      observationId,
      NEW_COLUMNS.holding_balance_observations ?? []
    );
    const ledger = await capturedBefore(
      tx,
      'holding_transactions',
      ledgerId,
      NEW_COLUMNS.holding_transactions ?? []
    );
    expect(Object.keys(observation)).not.toContain('role');
    expect(Object.keys(ledger)).not.toContain('ledger_kind');
    await tx.execute(sql`DELETE FROM holding_balance_observations WHERE id = ${observationId}`);
    await tx.execute(sql`DELETE FROM holding_transactions WHERE id = ${ledgerId}`);

    await tx.execute(restoreStatement(schema.holdingBalanceObservations, [observation]));
    await tx.execute(restoreStatement(schema.holdingTransactions, [ledger]));

    expect(await readNulls(tx, 'holding_balance_observations', observationId)).toEqual(
      allNull('holding_balance_observations')
    );
    expect(await readNulls(tx, 'holding_transactions', ledgerId)).toEqual(
      allNull('holding_transactions')
    );
  });
});

test('a row captured with its evidence restores with it', async () => {
  await inRollback(async (tx) => {
    const seed = await seedHolding(tx);
    const inputId = await id(tx, insertInput(seed));
    const decisionId = await id(tx, insertDecision(seed));
    const observationId = await id(
      tx,
      insertObservation(
        seed,
        sql`, role, authority, input_id, cause`,
        sql`, 'checkpoint', 'statement', ${inputId}, 'flow'`
      )
    );
    const ledgerId = await id(
      tx,
      insertLedgerRow(
        seed,
        sql`, ledger_kind, kind_subtype, group_id, input_id, execution_price, execution_price_token_id, kind_origin, decision_id`,
        sql`, 'income', 'interest', gen_random_uuid(), ${inputId}, '1.25', ${seed.tokenId}, 'jev', ${decisionId}`
      )
    );
    const observation = await capturedBefore(tx, 'holding_balance_observations', observationId, []);
    const ledger = await capturedBefore(tx, 'holding_transactions', ledgerId, []);
    await tx.execute(sql`DELETE FROM holding_balance_observations WHERE id = ${observationId}`);
    await tx.execute(sql`DELETE FROM holding_transactions WHERE id = ${ledgerId}`);

    await tx.execute(restoreStatement(schema.holdingBalanceObservations, [observation]));
    await tx.execute(restoreStatement(schema.holdingTransactions, [ledger]));

    expect(await capturedBefore(tx, 'holding_balance_observations', observationId, [])).toEqual(
      observation
    );
    expect(await capturedBefore(tx, 'holding_transactions', ledgerId, [])).toEqual(ledger);
    expect(ledger).toMatchObject({
      ledger_kind: 'income',
      input_id: inputId,
      decision_id: decisionId,
    });
  });
});

test('deleting an input nulls the evidence pointing at it', async () => {
  await inRollback(async (tx) => {
    const seed = await seedHolding(tx);
    const inputId = await id(tx, insertInput(seed));
    const observationId = await id(tx, insertObservation(seed, sql`, input_id`, sql`, ${inputId}`));
    const ledgerId = await id(tx, insertLedgerRow(seed, sql`, input_id`, sql`, ${inputId}`));

    await tx.execute(sql`DELETE FROM feed_inputs WHERE id = ${inputId}`);

    const observation = await one<{ input_id: string | null }>(
      tx,
      sql`SELECT input_id FROM holding_balance_observations WHERE id = ${observationId}`
    );
    const ledger = await one<{ input_id: string | null }>(
      tx,
      sql`SELECT input_id FROM holding_transactions WHERE id = ${ledgerId}`
    );
    expect(observation.input_id).toBeNull();
    expect(ledger.input_id).toBeNull();
  });
});

test('deleting a token or a decision nulls the ledger columns pointing at it', async () => {
  await inRollback(async (tx) => {
    const seed = await seedHolding(tx);
    const priceTokenId = await seedToken(tx);
    const decisionId = await id(tx, insertDecision(seed));
    const ledgerId = await id(
      tx,
      insertLedgerRow(
        seed,
        sql`, execution_price_token_id, decision_id`,
        sql`, ${priceTokenId}, ${decisionId}`
      )
    );

    await tx.execute(sql`DELETE FROM tokens WHERE id = ${priceTokenId}`);
    await tx.execute(sql`DELETE FROM judgment_decisions WHERE id = ${decisionId}`);

    const ledger = await one<{ token: string | null; decision: string | null }>(
      tx,
      sql`SELECT execution_price_token_id AS token, decision_id AS decision FROM holding_transactions WHERE id = ${ledgerId}`
    );
    expect(ledger).toEqual({ token: null, decision: null });
  });
});

test('a pointer at evidence that does not exist is refused', async () => {
  await inRollback(async (tx) => {
    const seed = await seedHolding(tx);
    const missing = sql`gen_random_uuid()`;

    expect(await refusedWith(tx, insertObservation(seed, sql`, input_id`, sql`, ${missing}`))).toBe(
      '23503'
    );
    expect(await refusedWith(tx, insertLedgerRow(seed, sql`, input_id`, sql`, ${missing}`))).toBe(
      '23503'
    );
    expect(
      await refusedWith(tx, insertLedgerRow(seed, sql`, decision_id`, sql`, ${missing}`))
    ).toBe('23503');
    expect(
      await refusedWith(
        tx,
        insertLedgerRow(seed, sql`, execution_price_token_id`, sql`, ${missing}`)
      )
    ).toBe('23503');
  });
});

test('every feed table keyed on a user has an index on user_id', async () => {
  await inRollback(async (tx) => {
    const found = await rows<{ indexname: string }>(
      tx,
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('idx_feed_inputs_user_id', 'idx_feed_match_rules_user_id', 'idx_outbox_events_user_id') ORDER BY indexname`
    );

    expect(found.map((r) => r.indexname)).toEqual([
      'idx_feed_inputs_user_id',
      'idx_feed_match_rules_user_id',
      'idx_outbox_events_user_id',
    ]);
  });
});

test("each new foreign key on the evidence tables has a partial index, so a parent's delete does not scan them", async () => {
  await inRollback(async (tx) => {
    const found = await rows<{ indexname: string; tablename: string; indexdef: string }>(
      tx,
      sql`SELECT indexname, tablename, indexdef FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename IN ('holding_balance_observations', 'holding_transactions')
            AND indexname IN ('idx_holding_obs_input_id', 'idx_holding_tx_input_id',
                              'idx_holding_tx_decision_id', 'idx_holding_tx_execution_price_token_id')
          ORDER BY indexname`
    );

    expect(found.map((r) => [r.indexname, r.tablename])).toEqual([
      ['idx_holding_obs_input_id', 'holding_balance_observations'],
      ['idx_holding_tx_decision_id', 'holding_transactions'],
      ['idx_holding_tx_execution_price_token_id', 'holding_transactions'],
      ['idx_holding_tx_input_id', 'holding_transactions'],
    ]);
    for (const { indexname, indexdef } of found) {
      const column = /\((\w+)\) WHERE \((\w+) IS NOT NULL\)$/.exec(indexdef);
      expect({ indexname, partialOn: column?.[1] === column?.[2] }).toEqual({
        indexname,
        partialOn: true,
      });
    }
  });
});
