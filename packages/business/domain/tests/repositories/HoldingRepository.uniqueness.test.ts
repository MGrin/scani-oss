import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// `holdings_account_token_external_uq` (migration 0043, SC-325) — a PARTIAL
// unique index on (account_id, token_id, external_id) WHERE external_id IS NOT
// NULL.
//
// These tests are the backfill check the migration itself cannot be. Adding a
// unique index over a populated table succeeds exactly when no existing row
// violates it, so "can these rows be inserted under the index" and "would
// CREATE UNIQUE INDEX have survived this population" are the same predicate.
// A test database migrated from empty never exercises either.
//
// The shapes below are transcribed from production on 2026-08-17, because the
// two shapes the constraint has to tell apart both look like duplicates from
// the schema and only one of them is.

async function scaffold(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  return { user, account, token };
}

describe('holdings uniqueness on (account_id, token_id, external_id)', () => {
  ***REMOVED***
  ***REMOVED***
  ***REMOVED***
  ***REMOVED***
  // forced a merge that loses ~137,000 RUB.
  ***REMOVED***
    await withTestDb(async (tx) => {
      const { user, account, token } = await scaffold(tx);
      ***REMOVED***
        await makeHolding(tx, {
          userId: user.id,
          accountId: account.id,
          tokenId: token.id,
          balance,
          source: 'manual',
          externalId: null,
        });
      }
      const rows = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, account.id));
      expect(rows.length).toBe(4);
    });
  });

  // Account 36032290 / token 8567a750 (Airwallex, USD). The imported row is
  // overwritten by every hourly sync; the hand-entered one beside it is not.
  // Two positions, not one duplicated — SC-303 kept this shape legal on
  // purpose and `findUnsyncedByAccountAndTokens` draws the same line.
  test('permits a synced row beside a hand-entered one for the same token', async () => {
    await withTestDb(async (tx) => {
      const { user, account, token } = await scaffold(tx);
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '601.5',
        source: 'import_airwallex',
        externalId: 'USD',
      });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '6217.95208495',
        source: 'manual',
        externalId: null,
      });
      const rows = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, account.id));
      expect(rows.length).toBe(2);
    });
  });

  // The invariant itself: an importer cannot fork its own position. This is
  // the TOCTOU `CreateHoldingsWithDependenciesUseCase` cannot close and the
  // shape that made the Airwallex transaction history land twice — `holding_tx
  // _dedup` is unique per HOLDING, so a second row for one address re-ingests
  // the whole ledger against it instead of deduping.
  test('refuses two rows sharing one external_id in the same account and token', async () => {
    await withTestDb(async (tx) => {
      const { user, account, token } = await scaffold(tx);
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        source: 'import_kraken',
        externalId: 'BTC',
      });
      // Asserted on the driver's `constraint_name` rather than the message:
      // drizzle wraps the pg error in a "Failed query:" string that names only
      // the statement, so a message match passes on any insert failure —
      // including one caused by a broken fixture.
      const error = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        source: 'import_kraken',
        externalId: 'BTC',
      }).then(
        () => null,
        (err: unknown) => err
      );
      expect(error).not.toBeNull();
      expect((error as { cause?: { constraint_name?: string } }).cause?.constraint_name).toBe(
        'holdings_account_token_external_uq'
      );
    });
  });

  // The index is scoped to the account, not the user: the same exchange asset
  // held on two connected accounts is two positions, and a key that collided
  // them would break every multi-account import.
  test('permits the same external_id under two different accounts', async () => {
    await withTestDb(async (tx) => {
      const { user, account, token } = await scaffold(tx);
      const institution = await makeInstitution(tx);
      const second = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      for (const accountId of [account.id, second.id]) {
        await makeHolding(tx, {
          userId: user.id,
          accountId,
          tokenId: token.id,
          source: 'import_kraken',
          externalId: 'BTC',
        });
      }
      const rows = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.tokenId, token.id));
      expect(rows.length).toBe(2);
    });
  });
});
