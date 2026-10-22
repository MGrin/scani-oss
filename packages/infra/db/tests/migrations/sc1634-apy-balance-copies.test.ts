import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { inRollback, seedHoldingCache, type Tx } from './foundation-helpers';

/**
 * SC-1634: the migration deletes exactly the balance copies the engine's rule
 * O3 excludes, and archives each one whole first. One row of every shape the
 * rule has to tell apart is seeded; the controls are the rows it must leave.
 */
const MIGRATION = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'migrations',
  '20261017072428_delete_the_apy_balance_copies_the_engine_excludes.sql'
);

async function one(tx: Tx, query: ReturnType<typeof sql>): Promise<string> {
  const rows = (await tx.execute(query)) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error('insert returned no id');
  return id;
}

interface World {
  userId: string;
  holdingId: string;
  otherHoldingId: string;
  copies: { marked: string; paired: string; answered: string };
  kept: Record<string, string>;
}

const COPY = { origin: 'updateHoldingBalance' };
const PAYOUT_AT = '2026-06-01T00:00:00.123456Z';
// The same millisecond as the payout, a different microsecond: the engine
// compares `Date`s, so this is a pair.
const PAIRED_AT = '2026-06-01T00:00:00.123999Z';

async function world(tx: Tx): Promise<World> {
  const tag = randomUUID().slice(0, 8);
  const tokenTypeId = await one(
    tx,
    sql`INSERT INTO token_types (code, name) VALUES (${`c-${tag}`}, 'c') RETURNING id`
  );
  const tokenId = await one(
    tx,
    sql`INSERT INTO tokens (symbol, name, type_id) VALUES (${`CT${tag}`}, 'c', ${tokenTypeId}) RETURNING id`
  );
  const userId = await one(
    tx,
    sql`INSERT INTO users (email, name) VALUES (${`c-${tag}@scani.local`}, 'c') RETURNING id`
  );
  const institutionTypeId = await one(
    tx,
    sql`INSERT INTO institution_types (code, name) VALUES (${`ci-${tag}`}, 'c') RETURNING id`
  );
  const institutionId = await one(
    tx,
    sql`INSERT INTO institutions (name, type_id) VALUES ('c', ${institutionTypeId}) RETURNING id`
  );
  const accountTypeId = await one(
    tx,
    sql`INSERT INTO account_types (code, name) VALUES (${`ca-${tag}`}, 'c') RETURNING id`
  );
  const accountId = await one(
    tx,
    sql`INSERT INTO accounts (user_id, institution_id, name, type_id)
        VALUES (${userId}, ${institutionId}, 'c', ${accountTypeId}) RETURNING id`
  );
  const holding = () =>
    seedHoldingCache(tx, () =>
      one(
        tx,
        sql`INSERT INTO holdings (user_id, account_id, token_id, balance)
            VALUES (${userId}, ${accountId}, ${tokenId}, '1') RETURNING id`
      )
    );
  const holdingId = await holding();
  const otherHoldingId = await holding();

  const ledger = (onHolding: string, source: string, createdAt: string) =>
    tx.execute(sql`
      INSERT INTO holding_transactions
        (user_id, holding_id, token_id, kind, quantity, occurred_at, external_id, source, created_at)
      VALUES (${userId}, ${onHolding}, ${tokenId}, 'deposit', '1', ${createdAt},
              ${randomUUID()}, ${source}, ${createdAt})`);
  // The rule reads `created_at`; each row gets its own `observed_at`, because
  // (holding, observed_at, source) is unique.
  let observed = 0;
  const observation = (
    onHolding: string,
    createdAt: string,
    fields: { source?: string; metadata?: object; role?: string; gapReview?: string } = {}
  ) =>
    one(
      tx,
      sql`INSERT INTO holding_balance_observations
            (user_id, holding_id, balance, observed_at, source, source_metadata, role,
             gap_review, created_at)
          VALUES (${userId}, ${onHolding}, '123.456789012345678901',
                  ${new Date(Date.UTC(2026, 0, 1, 0, 0, ++observed)).toISOString()},
                  ${fields.source ?? 'sync-capture'}, ${JSON.stringify(fields.metadata ?? COPY)}::jsonb,
                  ${fields.role ?? null}, ${fields.gapReview ?? null}, ${createdAt})
          RETURNING id`
    );

  await ledger(holdingId, 'apy-payout', PAYOUT_AT);
  await ledger(holdingId, 'apy-payout', '2026-06-02T00:00:00Z');
  await ledger(holdingId, 'apy-payout', '2026-06-03T00:02:00Z');
  await ledger(holdingId, 'statement-csv', '2026-06-03T00:01:00Z');
  await ledger(holdingId, 'apy-payout', '2026-06-04T00:00:00Z');

  const copies = {
    marked: await observation(holdingId, '2026-05-01T00:00:00Z', {
      metadata: { ...COPY, legacyAnchor: 'apy-payout' },
    }),
    paired: await observation(holdingId, PAIRED_AT),
    answered: await observation(holdingId, '2026-06-02T00:00:00Z', { gapReview: 'flow' }),
  };
  const kept = {
    // A row a writer gave a role is evidence, whatever the rule says of it.
    roled: await observation(holdingId, '2026-06-04T00:00:00Z', { role: 'verification' }),
    // O2 wins over O3: the file-import marker...
    fileImportMarker: await observation(holdingId, '2026-05-02T00:00:00Z', {
      metadata: { ...COPY, legacyAnchor: 'file-import' },
    }),
    // ...and a statement row written up to 120 s before the copy.
    statementWindow: await observation(holdingId, '2026-06-03T00:02:00Z'),
    // A payout on ANOTHER holding pairs nothing here.
    otherHolding: await observation(otherHoldingId, '2026-06-02T00:00:00Z'),
    // A balance copy at no payout instant is O5.
    unpaired: await observation(holdingId, '2026-05-03T00:00:00Z'),
    // Not a balance copy at all, at a payout instant.
    otherOrigin: await observation(holdingId, '2026-06-02T00:00:00Z', {
      metadata: { origin: 'providerSync' },
      gapReview: 'growth',
    }),
  };
  return { userId, holdingId, otherHoldingId, copies, kept };
}

async function migrate(tx: Tx): Promise<void> {
  await tx.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));
}

async function surviving(tx: Tx, w: World): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT id FROM holding_balance_observations WHERE user_id = ${w.userId}`)) as unknown as Array<{
    id: string;
  }>;
  return rows.map((r) => r.id).sort();
}

test('deletes exactly the copies rule O3 excludes, and keeps every control', async () => {
  await inRollback(async (tx) => {
    const w = await world(tx);
    await migrate(tx);
    expect(await surviving(tx, w)).toEqual(Object.values(w.kept).sort());
  });
});

test('archives each deleted copy whole, its answer and every digit included', async () => {
  await inRollback(async (tx) => {
    const w = await world(tx);
    await migrate(tx);
    const rows = (await tx.execute(sql`
      SELECT id, user_id, holding_id, observation
        FROM "_sc1634_apy_balance_copies_20261017"
       WHERE user_id = ${w.userId}`)) as unknown as Array<{
      id: string;
      user_id: string;
      holding_id: string;
      observation: Record<string, unknown>;
    }>;
    expect(rows.map((r) => r.id).sort()).toEqual(Object.values(w.copies).sort());
    const answered = rows.find((r) => r.id === w.copies.answered);
    expect(answered?.holding_id).toBe(w.holdingId);
    expect(answered?.observation.gap_review).toBe('flow');
    expect(answered?.observation.balance).toBe('123.456789012345678901');
    expect(answered?.observation.source_metadata).toEqual(COPY);
  });
});

test('the archive goes with its holding and with its user', async () => {
  await inRollback(async (tx) => {
    const w = await world(tx);
    await migrate(tx);
    const archived = async () =>
      Number(
        (
          (await tx.execute(sql`
            SELECT count(*)::int AS n FROM "_sc1634_apy_balance_copies_20261017"
             WHERE user_id = ${w.userId}`)) as unknown as Array<{ n: number }>
        )[0]?.n
      );
    expect(await archived()).toBe(3);
    await tx.execute(sql`DELETE FROM holdings WHERE id = ${w.holdingId}`);
    expect(await archived()).toBe(0);
  });
  await inRollback(async (tx) => {
    const w = await world(tx);
    await migrate(tx);
    await tx.execute(sql`DELETE FROM users WHERE id = ${w.userId}`);
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM "_sc1634_apy_balance_copies_20261017"
       WHERE user_id = ${w.userId}`)) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);
  });
});
