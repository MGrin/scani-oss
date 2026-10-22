import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { inRollback, seedHoldingCache, type Tx } from './foundation-helpers';

/**
 * Deleting a holding or an account deletes its `portfolio_value_daily` rows in
 * the same transaction, including an account's holdings that go by cascade
 * (SC-1627). Before the trigger every one of those rows stayed behind.
 */

async function one(tx: Tx, query: ReturnType<typeof sql>): Promise<string> {
  const rows = (await tx.execute(query)) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error('insert returned no id');
  return id;
}

interface World {
  userId: string;
  otherUserId: string;
  baseId: string;
  institutionId: string;
  kept: { accountId: string; holdingId: string };
  doomed: { accountId: string; holdingId: string };
  lone: string;
}

async function world(tx: Tx): Promise<World> {
  const tag = randomUUID().slice(0, 8);
  const tokenTypeId = await one(
    tx,
    sql`INSERT INTO token_types (code, name) VALUES (${`f-${tag}`}, 'f') RETURNING id`
  );
  const baseId = await one(
    tx,
    sql`INSERT INTO tokens (symbol, name, type_id) VALUES (${`FB${tag}`}, 'f', ${tokenTypeId}) RETURNING id`
  );
  const tokenId = await one(
    tx,
    sql`INSERT INTO tokens (symbol, name, type_id) VALUES (${`FT${tag}`}, 'f', ${tokenTypeId}) RETURNING id`
  );
  const user = (email: string) =>
    one(tx, sql`INSERT INTO users (email, name) VALUES (${email}, 'f') RETURNING id`);
  const userId = await user(`f-${tag}@scani.local`);
  const otherUserId = await user(`g-${tag}@scani.local`);
  const institutionTypeId = await one(
    tx,
    sql`INSERT INTO institution_types (code, name) VALUES (${`fi-${tag}`}, 'f') RETURNING id`
  );
  const institutionId = await one(
    tx,
    sql`INSERT INTO institutions (name, type_id) VALUES ('f', ${institutionTypeId}) RETURNING id`
  );
  const accountTypeId = await one(
    tx,
    sql`INSERT INTO account_types (code, name) VALUES (${`fa-${tag}`}, 'f') RETURNING id`
  );
  const account = (name: string) =>
    one(
      tx,
      sql`INSERT INTO accounts (user_id, institution_id, name, type_id)
          VALUES (${userId}, ${institutionId}, ${name}, ${accountTypeId}) RETURNING id`
    );
  const holding = (accountId: string) =>
    seedHoldingCache(tx, () =>
      one(
        tx,
        sql`INSERT INTO holdings (user_id, account_id, token_id, balance)
            VALUES (${userId}, ${accountId}, ${tokenId}, '1') RETURNING id`
      )
    );
  const keptAccount = await account('kept');
  const doomedAccount = await account('doomed');
  const w: World = {
    userId,
    otherUserId,
    baseId,
    institutionId,
    kept: { accountId: keptAccount, holdingId: await holding(keptAccount) },
    doomed: { accountId: doomedAccount, holdingId: await holding(doomedAccount) },
    lone: await holding(keptAccount),
  };
  const row = (userIdOf: string, scopeKind: string, scopeId: string) => sql`
    (${userIdOf}, ${scopeKind}, ${scopeId}, '2026-09-01', ${baseId}, '1', 'full', 1, 1)`;
  await tx.execute(sql`
    INSERT INTO portfolio_value_daily
      (user_id, scope_kind, scope_id, snapshot_date, base_currency_id, total_value,
       coverage_quality, holdings_with_known_value, holdings_total)
    VALUES ${sql.join(
      [
        row(userId, 'user', userId),
        row(userId, 'institution', institutionId),
        row(userId, 'account', keptAccount),
        row(userId, 'account', doomedAccount),
        row(userId, 'holding', w.kept.holdingId),
        row(userId, 'holding', w.doomed.holdingId),
        row(userId, 'holding', w.lone),
        row(userId, 'transit', w.lone),
        // Another user's row naming the same id is not this holding's.
        row(otherUserId, 'holding', w.lone),
      ],
      sql`, `
    )}`);
  return w;
}

async function scopes(tx: Tx, w: World): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT user_id, scope_kind, scope_id FROM portfolio_value_daily
    WHERE user_id IN (${w.userId}, ${w.otherUserId})`)) as unknown as Array<{
    user_id: string;
    scope_kind: string;
    scope_id: string;
  }>;
  const name = new Map([
    [w.userId, 'user'],
    [w.institutionId, 'institution'],
    [w.kept.accountId, 'kept-account'],
    [w.doomed.accountId, 'doomed-account'],
    [w.kept.holdingId, 'kept-holding'],
    [w.doomed.holdingId, 'doomed-holding'],
    [w.lone, 'lone'],
  ]);
  return rows
    .map(
      (r) => `${r.user_id === w.otherUserId ? 'other:' : ''}${r.scope_kind}/${name.get(r.scope_id)}`
    )
    .sort();
}

const ALL = [
  'account/doomed-account',
  'account/kept-account',
  'holding/doomed-holding',
  'holding/kept-holding',
  'holding/lone',
  'institution/institution',
  'other:holding/lone',
  'transit/lone',
  'user/user',
];

test('deleting a holding deletes its holding and transit rows, and no one else’s', async () => {
  await inRollback(async (tx) => {
    const w = await world(tx);
    expect(await scopes(tx, w)).toEqual(ALL);
    await tx.execute(sql`DELETE FROM holdings WHERE id = ${w.lone}`);
    expect(await scopes(tx, w)).toEqual(
      ALL.filter((s) => s !== 'holding/lone' && s !== 'transit/lone')
    );
  });
});

test('deleting an account deletes its rows and, by cascade, its holdings’ rows', async () => {
  await inRollback(async (tx) => {
    const w = await world(tx);
    await tx.execute(sql`DELETE FROM accounts WHERE id = ${w.doomed.accountId}`);
    expect(await scopes(tx, w)).toEqual(
      ALL.filter((s) => s !== 'account/doomed-account' && s !== 'holding/doomed-holding')
    );
  });
});
