import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src';
import type { DatabaseTransaction } from '../../src/transaction';

/**
 * The migration runs against the real schema, seeded with one row of every
 * shape it has to tell apart, inside a transaction that is rolled back.
 *
 * The rows this one must LEAVE carry most of the weight. Its predicate names
 * a kind, a source and an `external_id` pattern, and every one of those is a
 * place where too wide a match would take an ordinary transfer with it.
 */
const MIGRATION = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'migrations',
  '0049_sc339_sc352_drop_restated_solana_rows.sql'
);

/**
 * The file verbatim, minus its own transaction control — the test supplies
 * the transaction so the whole thing rolls back. Reading the file rather than
 * restating its SQL is the point: a copy would keep passing after the
 * migration changed.
 */
function migrationBody(): string {
  return readFileSync(MIGRATION, 'utf8').replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '');
}

class Rollback extends Error {}

interface Seeded {
  swapOutId: string;
  swapInId: string;
  zeroNativeId: string;
  transferBesideSwapId: string;
  etherscanSwapId: string;
  nonZeroSolanaId: string;
}

async function withSeededDb(
  assert: (tx: DatabaseTransaction, ids: Seeded) => Promise<void>,
  seedAnswered = false
): Promise<void> {
  const db = getDb();
  try {
    await db.transaction(async (tx) => {
      const one = async (query: ReturnType<typeof sql>): Promise<string> => {
        const rows = (await tx.execute(query)) as unknown as Array<{ id: string }>;
        const id = rows[0]?.id;
        if (!id) throw new Error('seed returned no id');
        return id;
      };

      const tokenTypeId = await one(sql`
        INSERT INTO token_types (code, name) VALUES ('crypto', 'Crypto')
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
      const instTypeId = await one(sql`
        INSERT INTO institution_types (code, name) VALUES ('wallet-0049', 'Wallet')
        RETURNING id`);
      const acctTypeId = await one(sql`
        INSERT INTO account_types (code, name) VALUES ('crypto-0049', 'Crypto')
        RETURNING id`);
      const institutionId = await one(sql`
        INSERT INTO institutions (name, type_id) VALUES ('Solana 0049', ${instTypeId}) RETURNING id`);
      const userId = await one(sql`
        INSERT INTO users (email, name)
        VALUES (concat('sc339-', gen_random_uuid(), '@example.test'), 'SC-339') RETURNING id`);
      const accountId = await one(sql`
        INSERT INTO accounts (user_id, institution_id, name, type_id)
        VALUES (${userId}, ${institutionId}, 'Solana - 0049', ${acctTypeId}) RETURNING id`);
      const tokenId = await one(sql`
        INSERT INTO tokens (symbol, name, type_id, market_segment)
        VALUES ('SOL', 'Solana', ${tokenTypeId}, 'solana:0049') RETURNING id`);
      const holdingId = await one(sql`
        INSERT INTO holdings (user_id, account_id, token_id, balance)
        VALUES (${userId}, ${accountId}, ${tokenId}, '10') RETURNING id`);

      const row = async (
        kind: string,
        quantity: string,
        externalId: string,
        source: string,
        review: string | null
      ): Promise<string> =>
        one(sql`
          INSERT INTO holding_transactions
            (user_id, holding_id, token_id, kind, quantity, occurred_at, external_id, source, transfer_review)
          VALUES (${userId}, ${holdingId}, ${tokenId}, ${sql.raw(`'${kind}'`)}, ${quantity},
                  now(), ${externalId}, ${source}, ${review})
          RETURNING id`);

      // The 15 + 13 production rows: a swap kind on a `-swap-N` external id,
      // unanswered and in no group.
      const swapOutId = await row(
        'swap_out',
        '-0.1',
        'SIG0049A-swap-0',
        'solana',
        seedAnswered ? 'left_control' : null
      );
      const swapInId = await row('swap_in', '0.11777182', 'SIG0049B-swap-1', 'solana', null);
      // The zero-lamport broadcast spam leg.
      const zeroNativeId = await row('transfer_in', '0', 'SIG0049C-native-0', 'solana', null);
      // The transfer legs on the SAME signature that already carry the same
      // lamports. These are the movement; they must all survive.
      const transferBesideSwapId = await row(
        'transfer_out',
        '-0.1',
        'SIG0049A-native-0',
        'solana',
        null
      );
      // A swap leg from a provider this migration is not about.
      const etherscanSwapId = await row('swap_out', '-0.05', '0x0049-swap-0', 'etherscan', null);
      // An ordinary nonzero solana row carrying a human's answer.
      const nonZeroSolanaId = await row(
        'transfer_out',
        '-2.5',
        'SIG0049D-native-1',
        'solana',
        'left_control'
      );

      await tx.execute(sql.raw(migrationBody()));

      await assert(tx, {
        swapOutId,
        swapInId,
        zeroNativeId,
        transferBesideSwapId,
        etherscanSwapId,
        nonZeroSolanaId,
      });
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

async function exists(tx: DatabaseTransaction, id: string): Promise<boolean> {
  const rows = (await tx.execute(
    sql`SELECT 1 AS hit FROM holding_transactions WHERE id = ${id}`
  )) as unknown as unknown[];
  return rows.length > 0;
}

describe('migration 0049 — restated Solana swap legs and zero-value transfers', () => {
  test('both swap legs are gone', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, ids.swapOutId)).toBe(false);
      expect(await exists(tx, ids.swapInId)).toBe(false);
    });
  });

  test('the zero-quantity solana row is gone', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, ids.zeroNativeId)).toBe(false);
    });
  });

  test('the transfer leg on the same signature survives — it is the movement', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, ids.transferBesideSwapId)).toBe(true);
    });
  });

  test('a swap leg from another provider is left alone', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, ids.etherscanSwapId)).toBe(true);
    });
  });

  test('an ordinary nonzero solana row keeps its answer', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, ids.nonZeroSolanaId)).toBe(true);
      const rows = (await tx.execute(
        sql`SELECT transfer_review FROM holding_transactions WHERE id = ${ids.nonZeroSolanaId}`
      )) as unknown as Array<{ transfer_review: string }>;
      expect(rows[0]?.transfer_review).toBe('left_control');
    });
  });

  test('a swap leg that acquired an answer stops the migration instead of vanishing', async () => {
    // Zero exist on production. If one appears between the measurement and
    // the deploy it is a thing to look at, and the loud failure is the point:
    // the quiet alternative deletes an answer a person gave.
    let raised: unknown;
    await withSeededDb(async () => {
      /* unreachable — the migration body throws first */
    }, true).catch((err) => {
      raised = err;
    });
    expect(String(raised)).toContain('SC-339');
  });
});
