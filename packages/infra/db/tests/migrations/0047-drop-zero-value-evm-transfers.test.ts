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
 * A data migration is the one kind whose bug is invisible in review: the SQL
 * is valid, it applies, and it takes the wrong rows. The only way to know it
 * takes the right ones is to give it rows to choose between — including the
 * ones it must LEAVE, which is where a predicate that is too wide shows up.
 */
const MIGRATION = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'migrations',
  '0047_sc348_drop_zero_value_evm_transfers.sql'
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
  zeroRowId: string;
  nonZeroRowId: string;
  solanaZeroRowId: string;
  spamTokenId: string;
  keptTokenId: string;
  oldTokenId: string;
}

async function withSeededDb(
  assert: (tx: DatabaseTransaction, ids: Seeded) => Promise<void>
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
        INSERT INTO institution_types (code, name) VALUES ('wallet-0047', 'Wallet')
        RETURNING id`);
      const acctTypeId = await one(sql`
        INSERT INTO account_types (code, name) VALUES ('crypto-0047', 'Crypto')
        RETURNING id`);
      const institutionId = await one(sql`
        INSERT INTO institutions (name, type_id) VALUES ('Ethereum 0047', ${instTypeId}) RETURNING id`);
      const userId = await one(sql`
        INSERT INTO users (email, name)
        VALUES (concat('sc348-', gen_random_uuid(), '@example.test'), 'SC-348') RETURNING id`);
      const accountId = await one(sql`
        INSERT INTO accounts (user_id, institution_id, name, type_id)
        VALUES (${userId}, ${institutionId}, 'Ethereum - 0x0047', ${acctTypeId}) RETURNING id`);

      // The REAL USDC contract — the one poisoning rides. It is kept, and so
      // is every nonzero row on it.
      const keptTokenId = await one(sql`
        INSERT INTO tokens (symbol, name, type_id, market_segment, created_at)
        VALUES ('USDC', 'USDC', ${tokenTypeId}, 'evm:1:0x0047real', TIMESTAMPTZ '2026-08-17 08:00:00+00')
        RETURNING id`);
      // A lookalike minted by the import and never used — inside the window.
      const spamTokenId = await one(sql`
        INSERT INTO tokens (symbol, name, type_id, market_segment, provider_metadata, created_at)
        VALUES ('USDC', 'USD Coin', ${tokenTypeId}, 'evm:1:0x0047spam',
                '{"etherscan":{"chainId":1,"contractAddress":"0x0047spam"}}'::jsonb,
                TIMESTAMPTZ '2026-08-17 08:00:00+00')
        RETURNING id`);
      // Same shape, minted BEFORE the window. Out of scope by design.
      const oldTokenId = await one(sql`
        INSERT INTO tokens (symbol, name, type_id, market_segment, provider_metadata, created_at)
        VALUES ('USDT', 'Tether USD', ${tokenTypeId}, 'evm:1:0x0047old',
                '{"etherscan":{"chainId":1,"contractAddress":"0x0047old"}}'::jsonb,
                TIMESTAMPTZ '2026-05-02 00:00:00+00')
        RETURNING id`);
      // Minted in the window and then actually used — a holding makes it real.
      const usedTokenId = await one(sql`
        INSERT INTO tokens (symbol, name, type_id, market_segment, provider_metadata, created_at)
        VALUES ('WETH', 'Wrapped Ether', ${tokenTypeId}, 'evm:1:0x0047used',
                '{"etherscan":{"chainId":1,"contractAddress":"0x0047used"}}'::jsonb,
                TIMESTAMPTZ '2026-08-17 08:00:00+00')
        RETURNING id`);

      const holdingId = await one(sql`
        INSERT INTO holdings (user_id, account_id, token_id, balance)
        VALUES (${userId}, ${accountId}, ${keptTokenId}, '100') RETURNING id`);
      await one(sql`
        INSERT INTO holdings (user_id, account_id, token_id, balance)
        VALUES (${userId}, ${accountId}, ${usedTokenId}, '1') RETURNING id`);

      // The poisoned row, carrying the unattributed answer the ten production
      // rows carry: `left_control` with no `transfer_reviewed_at`.
      const zeroRowId = await one(sql`
        INSERT INTO holding_transactions
          (user_id, holding_id, token_id, kind, quantity, occurred_at, external_id, source, transfer_review)
        VALUES (${userId}, ${holdingId}, ${keptTokenId}, 'transfer_out', '0',
                now(), '0xpoison-0x0047real', 'etherscan', 'left_control')
        RETURNING id`);
      const nonZeroRowId = await one(sql`
        INSERT INTO holding_transactions
          (user_id, holding_id, token_id, kind, quantity, occurred_at, external_id, source, transfer_review)
        VALUES (${userId}, ${holdingId}, ${keptTokenId}, 'transfer_out', '-161.382085',
                now(), '0xreal-0x0047real', 'etherscan', 'left_control')
        RETURNING id`);
      // A zero-quantity row from another provider. Two exist on production
      // (native SOL) and this migration is not about them.
      const solanaZeroRowId = await one(sql`
        INSERT INTO holding_transactions
          (user_id, holding_id, token_id, kind, quantity, occurred_at, external_id, source)
        VALUES (${userId}, ${holdingId}, ${keptTokenId}, 'transfer_in', '0',
                now(), 'solsig-native-0', 'solana')
        RETURNING id`);

      await tx.execute(sql.raw(migrationBody()));

      await assert(tx, {
        zeroRowId,
        nonZeroRowId,
        solanaZeroRowId,
        spamTokenId,
        keptTokenId,
        oldTokenId,
      });
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

async function exists(tx: DatabaseTransaction, table: string, id: string): Promise<boolean> {
  const rows = (await tx.execute(
    sql`SELECT 1 AS hit FROM ${sql.raw(table)} WHERE id = ${id}`
  )) as unknown as unknown[];
  return rows.length > 0;
}

describe('migration 0047 — zero-value EVM transfers and the tokens they minted', () => {
  test('the zero-quantity etherscan row is gone', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, 'holding_transactions', ids.zeroRowId)).toBe(false);
    });
  });

  test('the nonzero row beside it survives, answer and all', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, 'holding_transactions', ids.nonZeroRowId)).toBe(true);
      const rows = (await tx.execute(
        sql`SELECT transfer_review FROM holding_transactions WHERE id = ${ids.nonZeroRowId}`
      )) as unknown as Array<{ transfer_review: string }>;
      expect(rows[0]?.transfer_review).toBe('left_control');
    });
  });

  test('a zero-quantity row from another provider is left alone', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, 'holding_transactions', ids.solanaZeroRowId)).toBe(true);
    });
  });

  test('the orphan lookalike token is gone', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, 'tokens', ids.spamTokenId)).toBe(false);
    });
  });

  test('a token with a holding is never taken, however it looks', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, 'tokens', ids.keptTokenId)).toBe(true);
    });
  });

  test('an identically-shaped orphan from outside the window is out of scope', async () => {
    // 321 of these exist. Sweeping them in here would be a different decision
    // on different evidence — three are referenced elsewhere and 60 carry
    // price history.
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, 'tokens', ids.oldTokenId)).toBe(true);
    });
  });
});
