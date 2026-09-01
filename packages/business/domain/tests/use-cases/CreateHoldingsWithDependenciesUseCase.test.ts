/**
 * `CreateHoldingsWithDependenciesUseCase` — the writer behind every duplicate
 * (account_id, token_id) group in production (SC-303).
 *
 * All three groups measured on 2026-08-16 came through this call:
 *
 *   Bank     / RUB  4 manual rows, one transaction  (synthetic balances)
 *   Revolut  / USD  2 manual rows, one transaction  (6500.32 / 1004.59)
 *   Airwallex/ USD  1 manual row added six days after an import made another
 *
 * The first two are one payload carrying the same token more than once, and
 * neither was checked: the create/update split is made by the CLIENT, and
 * `apps/frontend/app/src/v3/lib/manual-entry.ts` hardcodes `updateHoldings:
 * []`, so the form can only ever ask for a create.
 *
 * The Airwallex one is a different shape and is deliberately still allowed —
 * the imported row carries an `external_id` its importer overwrites on every
 * sync, and whether the product wants both rows is not this guard's question
 * (SC-325).
 *
 * **`duplicateTokenIds` is tested directly, and that is not ceremony.** The
 * defect is a comparison that never runs. Every row the broken version writes
 * is individually valid, so a test asserting on the returned holdings goes
 * green against it.
 *
 * The injected transaction exists for these tests. Without it `execute` opens
 * and commits its own, and a rollback-isolated test cannot contain rows a
 * committed transaction wrote.
 */

import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import {
  CreateHoldingsWithDependenciesUseCase,
  duplicateTokenIds,
} from '../../src/use-cases/CreateHoldingsWithDependenciesUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * Constructed, not resolved. `bun test` loads every file into ONE process and
 * the container is global, so a `Container.set(CreateHoldingsWithDependencies
 * UseCase, …)` in another file's test — the worker's classification test does
 * exactly that — would hand `Container.get` a stub here. Class-field DI runs
 * on `new`, so the real dependencies still resolve.
 */
const useCase = () => new CreateHoldingsWithDependenciesUseCase();

describe('duplicateTokenIds', () => {
  test('a token asked for twice in one payload is a duplicate', () => {
    expect(duplicateTokenIds([{ tokenId: 'rub' }, { tokenId: 'rub' }], [])).toEqual(['rub']);
  });

  test('the Tinkoff shape — four lines, one token — reports that token once', () => {
    const four = [{ tokenId: 'rub' }, { tokenId: 'rub' }, { tokenId: 'rub' }, { tokenId: 'rub' }];
    expect(duplicateTokenIds(four, [])).toEqual(['rub']);
  });

  test('a token the account already holds manually is a duplicate', () => {
    expect(duplicateTokenIds([{ tokenId: 'usd' }], [{ tokenId: 'usd' }])).toEqual(['usd']);
  });

  test('distinct tokens over an unrelated existing holding are fine', () => {
    expect(
      duplicateTokenIds([{ tokenId: 'usd' }, { tokenId: 'eur' }], [{ tokenId: 'rub' }])
    ).toEqual([]);
  });

  test('an existing SYNCED holding does not block a manual one', () => {
    // The Airwallex pair. The caller passes only `external_id IS NULL` rows,
    // so the imported USD position never reaches this list — a manual USD
    // holding beside it is a second position, not a duplicated one, and
    // whether the product wants both is not this guard's question.
    expect(duplicateTokenIds([{ tokenId: 'usd' }], [])).toEqual([]);
  });

  // SC-330. The exhaustive matrix for the naming rule lives beside the rule
  // itself, in `@scani/shared`'s batch.test.ts — three surfaces refuse on it
  // and it is one function now. These two pin what this LAYER promises: that
  // it delegates, and that the original defect is still refused here.
  test('named pots are allowed — the Tinkoff four, which are real positions', () => {
    const pots = [
      { tokenId: 'rub', label: 'Current' },
      { tokenId: 'rub', label: 'Savings' },
      { tokenId: 'rub', label: 'Deposit' },
      { tokenId: 'rub', label: 'Cashback' },
    ];
    expect(duplicateTokenIds(pots, [])).toEqual([]);
  });

  test('unnamed rows collide exactly as they did before (SC-303)', () => {
    expect(duplicateTokenIds([{ tokenId: 'rub' }, { tokenId: 'rub' }], [])).toEqual(['rub']);
    expect(duplicateTokenIds([{ tokenId: 'rub' }], [{ tokenId: 'rub' }])).toEqual(['rub']);
  });
});

describe('CreateHoldingsWithDependenciesUseCase', () => {
  test('refuses a payload naming the same token twice', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { baseCurrencyId: (await makeToken(tx)).id });
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const rub = await makeToken(tx);

      await expect(
        useCase().execute(
          {
            accountId: account.id,
            holdings: [
              { tokenId: rub.id, balance: '2000.20' },
              { tokenId: rub.id, balance: '4000.40' },
            ],
          },
          user,
          tx
        )
      ).rejects.toThrow(/more than one holding/);

      const rows = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, account.id));
      expect(rows.length).toBe(0);
    });
  });

  test('refuses a token the account already holds by hand', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { baseCurrencyId: (await makeToken(tx)).id });
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const usd = await makeToken(tx);
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: usd.id,
        balance: '6500.32',
        source: 'manual',
      });

      await expect(
        useCase().execute(
          { accountId: account.id, holdings: [{ tokenId: usd.id, balance: '1004.59' }] },
          user,
          tx
        )
      ).rejects.toThrow(/more than one holding/);

      const rows = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, account.id));
      expect(rows.length).toBe(1);
    });
  });

  test('a statement-import row blocks it too — unsynced is wider than manual', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { baseCurrencyId: (await makeToken(tx)).id });
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const usd = await makeToken(tx);
      // `file-import` writes these with `external_id` NULL and finds them
      // again by (account, token). A hand-entered row beside one is the same
      // duplicate as two manual rows — nothing reconciles the two.
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: usd.id,
        balance: '0',
        source: 'statement-import',
      });

      await expect(
        useCase().execute(
          { accountId: account.id, holdings: [{ tokenId: usd.id, balance: '1004.59' }] },
          user,
          tx
        )
      ).rejects.toThrow(/more than one holding/);
    });
  });

  test('a synced holding for the token does not block the manual create', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { baseCurrencyId: (await makeToken(tx)).id });
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const usd = await makeToken(tx);
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: usd.id,
        balance: '1201.50',
        source: 'import_airwallex',
        externalId: 'USD',
      });

      const result = await useCase().execute(
        { accountId: account.id, holdings: [{ tokenId: usd.id, balance: '6217.15' }] },
        user,
        tx
      );

      expect(result.holdings.length).toBe(1);
      const rows = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, account.id));
      expect(rows.length).toBe(2);
    });
  });

  test('distinct tokens still create one row each', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { baseCurrencyId: (await makeToken(tx)).id });
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const usd = await makeToken(tx);
      const eur = await makeToken(tx);

      const result = await useCase().execute(
        {
          accountId: account.id,
          holdings: [
            { tokenId: usd.id, balance: '10' },
            { tokenId: eur.id, balance: '20' },
          ],
        },
        user,
        tx
      );

      expect(result.holdings.length).toBe(2);
    });
  });
});
