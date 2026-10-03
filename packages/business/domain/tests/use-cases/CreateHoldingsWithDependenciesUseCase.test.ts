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
 *
 * Foundation A2 moved the writes onto `HoldingResolver` and
 * `SnapshotWriter.record` (Task 4). The last block pins what the move may and
 * may not change: the observation now carries its labels, and history reads the
 * same. Its golden figures are computed by hand from the fixture, and the block
 * passed on the path before the move, so they are that path's figures.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { asc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { FoundationClassificationService } from '../../src/services/foundation/FoundationClassificationService';
import {
  CreateHoldingsWithDependenciesUseCase,
  duplicateTokenIds,
} from '../../src/use-cases/CreateHoldingsWithDependenciesUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeCheckpoint,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';
import { expectHistoryUnchanged, type HistoryReading } from '../../test/helpers/history-neutrality';
import { expectLabelsSettled } from '../../test/helpers/labels-settled';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const createdUserIds: string[] = [];
const createdTokenIds: string[] = [];
const createdInstitutionIds: string[] = [];

// The committed fixtures below. Tokens and institutions are not reachable from
// the user cascade, so they go explicitly, after the users whose holdings
// restrict them (SC-230).
afterEach(async () => {
  const db = getDb();
  const users = createdUserIds.splice(0);
  const tokens = createdTokenIds.splice(0);
  const institutions = createdInstitutionIds.splice(0);
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (tokens.length) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
  if (institutions.length) {
    await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
  }
});

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

const JUNE_1 = new Date('2026-06-01T00:00:00Z');
const JULY_1 = new Date('2026-07-01T00:00:00Z');
const LONG_AGO = new Date('2026-01-01T00:00:00Z');

const observationsOf = (tx: DatabaseTransaction, holdingId: string) =>
  tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
    .orderBy(asc(schema.holdingBalanceObservations.observedAt));

async function holdingRow(tx: DatabaseTransaction, holdingId: string) {
  const [row] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error(`holding ${holdingId} is gone`);
  return row;
}

/**
 * Committed, because the history and label helpers read committed rows. A
 * user holding 100 by hand since 1 June, observed then, with a deposit of 10 on
 * 1 July the balance never caught up with; and a second token to create.
 */
async function committedFixture() {
  const fixture = await getDb().transaction(async (tx) => {
    const base = await makeToken(tx);
    const user = await makeUser(tx, { baseCurrencyId: base.id });
    const bank = await makeInstitutionType(tx, { code: 'bank' });
    const institution = await makeInstitution(tx, { typeId: bank.id });
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const usd = await makeToken(tx);
    const eur = await makeToken(tx);
    const existing = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: usd.id,
      balance: '100',
      createdAt: JUNE_1,
      lastUpdated: JUNE_1,
    });
    await tx.insert(schema.holdingBalanceObservations).values({
      userId: user.id,
      holdingId: existing.id,
      balance: '100',
      observedAt: JUNE_1,
      source: 'sync-capture',
      sourceMetadata: { origin: 'updateHolding' },
    });
    await makeHoldingTransaction(tx, {
      userId: user.id,
      holdingId: existing.id,
      kind: 'deposit',
      quantity: '10',
      occurredAt: JULY_1,
      source: 'user-entered',
    });
    createdUserIds.push(user.id);
    createdTokenIds.push(base.id, usd.id, eur.id);
    createdInstitutionIds.push(institution.id);
    return { user, account, existing, eur };
  });
  return fixture;
}

/** One create and one update, committed by the caller's transaction. */
async function createAndUpdate(fixture: Awaited<ReturnType<typeof committedFixture>>) {
  return getDb().transaction((tx) =>
    useCase().execute(
      {
        accountId: fixture.account.id,
        holdings: [{ tokenId: fixture.eur.id, balance: '250' }],
        updateHoldings: [{ holdingId: fixture.existing.id, balance: '110' }],
      },
      fixture.user,
      tx
    )
  );
}

describe('CreateHoldingsWithDependenciesUseCase writes through SnapshotWriter (foundation A2)', () => {
  test('a created holding has exactly one observation: role snapshot, cause flow, source sync-capture, origin createHoldingWithEvent', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { baseCurrencyId: (await makeToken(tx)).id });
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const eur = await makeToken(tx);
      const before = Date.now();

      const result = await useCase().execute(
        {
          accountId: account.id,
          holdings: [{ tokenId: eur.id, balance: '2000.20', label: '  Savings ' }],
        },
        user,
        tx
      );

      const after = Date.now();
      expect(result.holdings).toHaveLength(1);
      const created = result.holdings[0]!;
      const row = await holdingRow(tx, created.id);
      // What the caller gets back is the row as it stands, figure included:
      // the worker prices and reports from it.
      expect(created).toEqual(row);
      expect(row).toMatchObject({
        userId: user.id,
        accountId: account.id,
        tokenId: eur.id,
        balance: '2000.20',
        source: 'manual',
        arrival: 'user_confirmed',
        label: 'Savings',
        externalId: null,
        kind: 'snapshot',
      });
      expect(row.lastUpdated.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.lastUpdated.getTime()).toBeLessThanOrEqual(after);

      const rows = await observationsOf(tx, created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: user.id,
        balance: '2000.20',
        source: 'sync-capture',
        sourceMetadata: { origin: 'createHoldingWithEvent', source: 'manual' },
        role: 'snapshot',
        authority: 'person',
        inputId: null,
        cause: 'flow',
        supersededAt: null,
        gapReview: null,
      });
      expect(rows[0]!.observedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(rows[0]!.observedAt.getTime()).toBeLessThanOrEqual(after);
      // D-6: the holding starts at its first value.
      expect(row.startsAt).toEqual(rows[0]!.observedAt);
    });
  });

  test('an update on a feed holding whose feed has begun writes a verification and sets the balance', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { baseCurrencyId: (await makeToken(tx)).id });
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const usd = await makeToken(tx);
      const feed = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: usd.id,
        balance: '100',
        source: 'import_airwallex',
        externalId: 'USD',
        kind: 'feed',
        startsAt: LONG_AGO,
        lastUpdated: LONG_AGO,
      });
      // Its feed's first evidence, so a value after it is a verification (Rule P).
      await makeCheckpoint(tx, { userId: user.id, holdingId: feed.id, observedAt: LONG_AGO });
      const before = Date.now();

      const result = await useCase().execute(
        {
          accountId: account.id,
          holdings: [],
          updateHoldings: [{ holdingId: feed.id, balance: '175' }],
        },
        user,
        tx
      );

      const after = Date.now();
      expect(result.updatedHoldingIds).toEqual([feed.id]);
      const row = await holdingRow(tx, feed.id);
      expect(row.balance).toBe('175');
      expect(row.lastUpdated.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.lastUpdated.getTime()).toBeLessThanOrEqual(after);
      expect(row.kind).toBe('feed');
      expect(row.startsAt).toEqual(LONG_AGO);

      const rows = (await observationsOf(tx, feed.id)).filter((o) => o.authority === 'person');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        balance: '175',
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHoldingBalance' },
        role: 'verification',
        authority: 'person',
        inputId: null,
        cause: null,
        supersededAt: null,
      });
      expect(rows[0]!.observedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(rows[0]!.observedAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  test('history unchanged', async () => {
    const fixture = await committedFixture();
    const created = (await createAndUpdate(fixture)).holdings[0]!;
    const justAfter = new Date();

    // Hand-computed from the fixture, and what the path before the move gave.
    //   existing  15 May   before every record: walks back to the 1 June 100
    //             15 June  110 now, less the 10 deposited on 1 July
    //             15 July  the 110 the update recorded
    //   created   15 May   before it existed: its first value, 250
    const golden: Array<[string, Date, string]> = [
      [fixture.existing.id, new Date('2026-05-15T00:00:00Z'), '100'],
      [fixture.existing.id, new Date('2026-06-15T00:00:00Z'), '100'],
      [fixture.existing.id, new Date('2026-07-15T00:00:00Z'), '110'],
      [fixture.existing.id, justAfter, '110'],
      [fixture.existing.id, new Date(), '110'],
      [created.id, new Date('2026-05-15T00:00:00Z'), '250'],
      [created.id, justAfter, '250'],
      [created.id, new Date(), '250'],
    ];
    const readings: HistoryReading[] = golden.map(([holdingId, at, balance]) => ({
      holdingId,
      at,
      balance,
      anchor: null,
    }));

    await expectHistoryUnchanged(readings);
    // The control: a figure the walk does not give is caught.
    await expect(
      expectHistoryUnchanged(readings.map((r, i) => (i === 1 ? { ...r, balance: '110' } : r)))
    ).rejects.toThrow();
  });

  test('expectLabelsSettled', async () => {
    const fixture = await committedFixture();
    await Container.get(FoundationClassificationService).classify({
      apply: true,
      userId: fixture.user.id,
    });

    await createAndUpdate(fixture);

    await expectLabelsSettled(fixture.user.id);
  });
});
