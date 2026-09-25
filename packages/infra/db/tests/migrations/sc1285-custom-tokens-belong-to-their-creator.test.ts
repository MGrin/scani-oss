import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src';
import type { DatabaseTransaction } from '../../src/transaction';

/**
 * SC-1285's migration, run verbatim against the real schema inside a
 * transaction that is rolled back. It has already run on this database, so
 * every seeded row starts with no owner, exactly as production's did.
 *
 * The case that matters most is the one production actually has: on
 * 2026-09-19 a second account EDITED a token it did not create. A backfill
 * that took the first or the latest editor could hand that token to the
 * attacker; this one takes the row written with the token, and the seed puts
 * a foreign edit on the same token to prove it.
 */
const MIGRATION = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'migrations',
  '20260921040138_sc1285_custom_tokens_belong_to_their_creator.sql'
);

class Rollback extends Error {}

type Tx = DatabaseTransaction;

async function one(tx: Tx, query: ReturnType<typeof sql>): Promise<string> {
  const rows = (await tx.execute(query)) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error('seed returned no id');
  return id;
}

async function ownerOf(tx: Tx, tokenId: string): Promise<string | null> {
  const rows = (await tx.execute(
    sql`SELECT created_by_user_id AS owner FROM tokens WHERE id = ${tokenId}`
  )) as unknown as Array<{ owner: string | null }>;
  return rows[0]?.owner ?? null;
}

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      await body(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

async function seedTypes(tx: Tx) {
  const typeId = async (code: string) =>
    one(
      tx,
      sql`INSERT INTO token_types (code, name) VALUES (${code}, ${code})
          ON CONFLICT (code) DO UPDATE SET name = token_types.name RETURNING id`
    );
  return {
    privateCompany: await typeId('private-company'),
    other: await typeId('other'),
    crypto: await typeId('crypto'),
    fiat: await typeId('fiat'),
  };
}

async function seedUser(tx: Tx, label: string) {
  return one(
    tx,
    sql`INSERT INTO users (email, name)
        VALUES (concat('sc1285-', ${label}::text, '-', gen_random_uuid(), '@example.test'), ${label}::text)
        RETURNING id`
  );
}

describe('SC-1285 migration: custom tokens belong to their creator', () => {
  test('backfills the owner from the creation row, then the only holder, else nobody', async () => {
    await inRolledBackTx(async (tx) => {
      const types = await seedTypes(tx);
      const [creator, attacker, holder, other] = [
        await seedUser(tx, 'creator'),
        await seedUser(tx, 'attacker'),
        await seedUser(tx, 'holder'),
        await seedUser(tx, 'other'),
      ];
      const base = await one(
        tx,
        sql`INSERT INTO tokens (symbol, name, type_id, market_segment)
            VALUES ('USD', 'US Dollar', ${types.fiat}, 'sc1285-base') RETURNING id`
      );
      const token = (symbol: string, typeId: string) =>
        one(
          tx,
          sql`INSERT INTO tokens (symbol, name, type_id, market_segment)
              VALUES (${symbol}, ${symbol}, ${typeId}, ${`sc1285-${symbol}`}) RETURNING id`
        );
      // `now()` is the transaction's start time, so a row inserted with the
      // default here has the same `created_at` as the token — which is exactly
      // what the real creation transaction produces. A later edit is dated
      // explicitly after it.
      const edit = (tokenId: string, userId: string, later: boolean) =>
        tx.execute(sql`
          INSERT INTO token_price_edit_history
            (token_id, base_token_id, previous_price, new_price, edited_by_user_id, reason, created_at)
          VALUES (${tokenId}, ${base}, ${later ? '1' : null}::text, '2', ${userId},
                  ${later ? 'edited by acctB' : 'Initial price'}::text,
                  ${later ? sql`now() + interval '1 minute'` : sql`now()`})`);

      const institutionType = await one(
        tx,
        sql`INSERT INTO institution_types (code, name) VALUES ('sc1285-bank', 'Bank') RETURNING id`
      );
      const accountType = await one(
        tx,
        sql`INSERT INTO account_types (code, name) VALUES ('sc1285-acct', 'Acct') RETURNING id`
      );
      const institution = await one(
        tx,
        sql`INSERT INTO institutions (name, type_id) VALUES ('SC-1285', ${institutionType}) RETURNING id`
      );
      const hold = async (userId: string, tokenId: string) => {
        const account = await one(
          tx,
          sql`INSERT INTO accounts (user_id, institution_id, name, type_id)
              VALUES (${userId}, ${institution}, ${`sc1285-${crypto.randomUUID()}`}, ${accountType})
              RETURNING id`
        );
        await tx.execute(sql`
          INSERT INTO holdings (user_id, account_id, token_id, balance)
          VALUES (${userId}, ${account}, ${tokenId}, '1')`);
      };

      // Created by `creator`, then edited by `attacker` — the 2026-09-19 shape.
      const edited = await token('EDITED', types.privateCompany);
      await edit(edited, creator, false);
      await edit(edited, attacker, true);
      await hold(attacker, edited);

      // No creation row, one holder (twice): the `createPrivateToken` shape.
      const heldOnce = await token('HELDONCE', types.other);
      await hold(holder, heldOnce);
      await hold(holder, heldOnce);

      // No creation row, two holders: nothing says whose it is.
      const heldTwice = await token('HELDTWICE', types.privateCompany);
      await hold(creator, heldTwice);
      await hold(other, heldTwice);

      // Only a LATER edit, nobody holds it: an editor is not a creator.
      const editedOnly = await token('EDITEDONLY', types.privateCompany);
      await edit(editedOnly, attacker, true);

      // A catalog token with a creation-shaped row is never owned.
      const catalog = await token('CATALOG', types.crypto);
      await edit(catalog, creator, false);

      // Already owned: the migration does not rewrite it.
      const owned = await token('OWNED', types.privateCompany);
      await tx.execute(sql`UPDATE tokens SET created_by_user_id = ${other} WHERE id = ${owned}`);
      await edit(owned, creator, false);

      await tx.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));

      expect(await ownerOf(tx, edited)).toBe(creator);
      expect(await ownerOf(tx, heldOnce)).toBe(holder);
      expect(await ownerOf(tx, heldTwice)).toBeNull();
      expect(await ownerOf(tx, editedOnly)).toBeNull();
      expect(await ownerOf(tx, catalog)).toBeNull();
      expect(await ownerOf(tx, owned)).toBe(other);

      // Idempotent: a second run changes nothing.
      await tx.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));
      expect(await ownerOf(tx, edited)).toBe(creator);
      expect(await ownerOf(tx, owned)).toBe(other);
    });
  });

  test('a symbol is unique per owner, and still unique across the unowned catalog', async () => {
    await inRolledBackTx(async (tx) => {
      const types = await seedTypes(tx);
      const [a, b] = [await seedUser(tx, 'a'), await seedUser(tx, 'b')];
      const insert = (owner: string | null, typeId = types.privateCompany) =>
        tx.transaction(async (sp) => {
          await sp.execute(sql`
            INSERT INTO tokens (symbol, name, type_id, created_by_user_id)
            VALUES ('SC1285UNIQ', 'x', ${typeId}, ${owner}::uuid)`);
        });
      const refused = (p: Promise<unknown>) =>
        p.then(
          () => false,
          () => true
        );

      expect(await refused(insert(a))).toBe(false);
      expect(await refused(insert(b))).toBe(false);
      expect(await refused(insert(a))).toBe(true);

      expect(await refused(insert(null, types.crypto))).toBe(false);
      expect(await refused(insert(null, types.crypto))).toBe(true);
    });
  });
});
