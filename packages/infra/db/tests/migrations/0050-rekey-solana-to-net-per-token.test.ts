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
 * The weight here is on the ARCHIVE rather than the delete. Deleting every
 * `solana` row is the easy half and hard to get wrong; the half that has to
 * hold is that each deleted row is recoverable, and that the key it names is
 * the key the rewritten provider will actually write — otherwise "which new
 * row absorbed this answer" stops being answerable the moment it matters.
 */
const MIGRATION = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'migrations',
  '0050_sc357_rekey_solana_to_net_per_token.sql'
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
  nativeLegId: string;
  wsolLegId: string;
  answeredId: string;
  groupedId: string;
  usdcLegId: string;
  etherscanId: string;
  solHoldingId: string;
  usdcHoldingId: string;
}

async function withSeededDb(
  assert: (tx: DatabaseTransaction, ids: Seeded) => Promise<void>,
  seedAttributedAnswer = false
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
        INSERT INTO institution_types (code, name) VALUES ('wallet-0050', 'Wallet')
        RETURNING id`);
      const acctTypeId = await one(sql`
        INSERT INTO account_types (code, name) VALUES ('crypto-0050', 'Crypto')
        RETURNING id`);
      const institutionId = await one(sql`
        INSERT INTO institutions (name, type_id) VALUES ('Solana 0050', ${instTypeId}) RETURNING id`);
      const userId = await one(sql`
        INSERT INTO users (email, name)
        VALUES (concat('sc357-', gen_random_uuid(), '@example.test'), 'SC-357') RETURNING id`);
      const accountId = await one(sql`
        INSERT INTO accounts (user_id, institution_id, name, type_id)
        VALUES (${userId}, ${institutionId}, 'Solana - 0050', ${acctTypeId}) RETURNING id`);
      const solTokenId = await one(sql`
        INSERT INTO tokens (symbol, name, type_id, market_segment)
        VALUES ('SOL', 'Solana', ${tokenTypeId}, 'solana:0050') RETURNING id`);
      const usdcTokenId = await one(sql`
        INSERT INTO tokens (symbol, name, type_id, market_segment)
        VALUES ('USDC', 'USD Coin', ${tokenTypeId}, 'solana:0050u') RETURNING id`);
      // `holdings.external_id` IS the provider's per-token key — `'native'`
      // for SOL, the mint for an SPL token, both written by
      // `SolanaProvider.fetchBalances`. That is what makes the new
      // `external_id` derivable rather than guessed.
      const solHoldingId = await one(sql`
        INSERT INTO holdings (user_id, account_id, token_id, balance, external_id)
        VALUES (${userId}, ${accountId}, ${solTokenId}, '10', 'native') RETURNING id`);
      const usdcHoldingId = await one(sql`
        INSERT INTO holdings (user_id, account_id, token_id, balance, external_id)
        VALUES (${userId}, ${accountId}, ${usdcTokenId}, '5',
                'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') RETURNING id`);

      await tx.execute(sql`
        INSERT INTO holding_coverage
          (holding_id, first_tx_at, last_tx_at, tx_sources, has_complete_tx_history,
           opening_balance_quantity, reconciliation_notes)
        VALUES (${solHoldingId}, now(), now(), ARRAY['solana'], true,
                '-1.5', 'Missing inflows of 1.5')`);

      const row = async (
        holdingId: string,
        tokenId: string,
        kind: string,
        quantity: string,
        externalId: string,
        source: string,
        review: string | null,
        attributed = false,
        groupId: string | null = null
      ): Promise<string> =>
        one(sql`
          INSERT INTO holding_transactions
            (user_id, holding_id, token_id, kind, quantity, occurred_at, external_id,
             source, transfer_review, transfer_reviewed_at, transfer_group_id)
          VALUES (${userId}, ${holdingId}, ${tokenId}, ${sql.raw(`'${kind}'`)}, ${quantity},
                  now(), ${externalId}, ${source}, ${review},
                  ${attributed ? sql`now()` : sql`NULL`}, ${groupId})
          RETURNING id`);

      const nativeLegId = await row(
        solHoldingId,
        solTokenId,
        'transfer_out',
        '-0.5',
        'SIG0050A-native-3',
        'solana',
        null
      );
      // A WSOL leg: it sits on the SOL holding, because WSOL resolves to the
      // same token identity — which is the whole double count. It must map to
      // the SAME new key as the native leg on its signature.
      const wsolLegId = await row(
        solHoldingId,
        solTokenId,
        'transfer_out',
        '-0.5',
        'SIG0050A-token-0',
        'solana',
        null
      );
      const answeredId = await row(
        solHoldingId,
        solTokenId,
        'transfer_out',
        '-2.5',
        'SIG0050B-native-1',
        'solana',
        'left_control',
        seedAttributedAnswer
      );
      const groupId = '00000000-0000-4000-8000-000000000050';
      const groupedId = await row(
        solHoldingId,
        solTokenId,
        'transfer_in',
        '0.00203928',
        'SIG0050C-native-4',
        'solana',
        null,
        false,
        groupId
      );
      const usdcLegId = await row(
        usdcHoldingId,
        usdcTokenId,
        'transfer_in',
        '2250',
        'SIG0050D-token-0',
        'solana',
        null
      );
      const etherscanId = await row(
        solHoldingId,
        solTokenId,
        'transfer_out',
        '-1',
        '0x0050-0',
        'etherscan',
        'left_control',
        true
      );

      await tx.execute(sql.raw(migrationBody()));

      await assert(tx, {
        nativeLegId,
        wsolLegId,
        answeredId,
        groupedId,
        usdcLegId,
        etherscanId,
        solHoldingId,
        usdcHoldingId,
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

async function archived(
  tx: DatabaseTransaction,
  id: string
): Promise<
  | {
      old_external_id: string;
      new_external_id: string;
      transfer_review: string | null;
      transfer_group_id: string | null;
      quantity: string;
    }
  | undefined
> {
  const rows = (await tx.execute(sql`
    SELECT old_external_id, new_external_id, transfer_review, transfer_group_id, quantity
      FROM "_sc357_solana_rekey_20260817" WHERE id = ${id}`)) as unknown as Array<{
    old_external_id: string;
    new_external_id: string;
    transfer_review: string | null;
    transfer_group_id: string | null;
    quantity: string;
  }>;
  return rows[0];
}

describe('migration 0050 — re-key Solana from one row per leg to one per token', () => {
  test('every solana row is gone', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, ids.nativeLegId)).toBe(false);
      expect(await exists(tx, ids.wsolLegId)).toBe(false);
      expect(await exists(tx, ids.answeredId)).toBe(false);
      expect(await exists(tx, ids.groupedId)).toBe(false);
      expect(await exists(tx, ids.usdcLegId)).toBe(false);
    });
  });

  test('a row from another provider is left alone, answer and all', async () => {
    await withSeededDb(async (tx, ids) => {
      expect(await exists(tx, ids.etherscanId)).toBe(true);
      const rows = (await tx.execute(sql`
        SELECT transfer_review, transfer_reviewed_at FROM holding_transactions
         WHERE id = ${ids.etherscanId}`)) as unknown as Array<{
        transfer_review: string;
        transfer_reviewed_at: Date | null;
      }>;
      expect(rows[0]?.transfer_review).toBe('left_control');
      expect(rows[0]?.transfer_reviewed_at).not.toBeNull();
      // …and it is not swept into an archive about Solana.
      expect(await archived(tx, ids.etherscanId)).toBeUndefined();
    });
  });

  test('the native leg and the WSOL leg of one signature map to the SAME new key', async () => {
    // They are the same 0.5 SOL. One row replaces both, so both archive rows
    // have to point at it or the mapping loses the duplicate it was built to
    // explain.
    await withSeededDb(async (tx, ids) => {
      const native = await archived(tx, ids.nativeLegId);
      const wsol = await archived(tx, ids.wsolLegId);
      expect(native?.new_external_id).toBe('SIG0050A-net-native');
      expect(wsol?.new_external_id).toBe('SIG0050A-net-native');
      expect(native?.old_external_id).toBe('SIG0050A-native-3');
      expect(wsol?.old_external_id).toBe('SIG0050A-token-0');
    });
  });

  test('an SPL row maps to its mint, taken from the holding the provider keyed', async () => {
    await withSeededDb(async (tx, ids) => {
      expect((await archived(tx, ids.usdcLegId))?.new_external_id).toBe(
        'SIG0050D-net-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      );
    });
  });

  test('the answer and the group survive in the archive, not in the ledger', async () => {
    await withSeededDb(async (tx, ids) => {
      const answered = await archived(tx, ids.answeredId);
      expect(answered?.transfer_review).toBe('left_control');
      expect(answered?.quantity).toBe('-2.5');
      expect(answered?.new_external_id).toBe('SIG0050B-net-native');
      const grouped = await archived(tx, ids.groupedId);
      expect(grouped?.transfer_group_id).toBe('00000000-0000-4000-8000-000000000050');
    });
  });

  test('the completeness claim and the derived bounds are retracted', async () => {
    await withSeededDb(async (tx, ids) => {
      const rows = (await tx.execute(sql`
        SELECT has_complete_tx_history, first_tx_at, opening_balance_quantity, reconciliation_notes
          FROM holding_coverage WHERE holding_id = ${ids.solHoldingId}`)) as unknown as Array<{
        has_complete_tx_history: boolean;
        first_tx_at: Date | null;
        opening_balance_quantity: string | null;
        reconciliation_notes: string | null;
      }>;
      expect(rows[0]?.has_complete_tx_history).toBe(false);
      expect(rows[0]?.first_tx_at).toBeNull();
      expect(rows[0]?.opening_balance_quantity).toBeNull();
      expect(rows[0]?.reconciliation_notes).toBeNull();
    });
  });

  test('an ATTRIBUTED answer stops the migration instead of vanishing', async () => {
    ***REMOVED***
    // `transfer_reviewed_at` and a null `transfer_review_source`. If one is
    // answered between the measurement and the deploy, the loud failure is
    // the point — the quiet alternative discards a decision a person made.
    let raised: unknown;
    await withSeededDb(async () => {
      /* unreachable — the migration body throws first */
    }, true).catch((err) => {
      raised = err;
    });
    expect(String(raised)).toContain('SC-357');
    expect(String(raised)).toContain('ATTRIBUTED');
  });
});
