/**
 * Balance batches through `FeedIngestService.ingest` (foundation A2 Task 15):
 * the options the snapshot adapter's paths need. `external-id` is the
 * integration import's match, `createdCheckpointMeta` its create stamp;
 * `unchangedCheckpoint: 'skip'` and
 * `update-only` are the balance syncs' (Task 16), and the skip happens after
 * placement so a skipped holding still counts as reported (R62 Q2).
 *
 * Every test runs inside a rolled-back transaction.
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { FeedIngestService } from '../../../src/services/feeds/FeedIngestService';
import type {
  AssetRef,
  FeedBatch,
  FeedCheckpoint,
  LegacyBatchOptions,
} from '../../../src/services/feeds/feed-batch';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeCheckpoint,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';

const ingest = (batch: FeedBatch, tx: DatabaseTransaction) =>
  Container.get(FeedIngestService).ingest(batch, tx);

const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const CAPTURED = new Date('2026-09-20T08:00:00Z');
const FETCHED = new Date('2026-09-20T09:00:00Z');
const TAG = 'import_snapshots-test';
const UPDATE_ORIGIN = { origin: 'updateHoldingBalanceWithEvent' };
const CREATE_STAMP = { origin: 'createHoldingWithEvent', source: TAG };

const freshSymbol = () => `S${randomUUID().replace(/-/g, '').toUpperCase()}`;

const catalog = (symbol: string, key?: string): AssetRef => ({
  ...(key === undefined ? {} : { key }),
  identity: { symbol, name: symbol },
  typeCode: 'crypto',
  lookup: 'catalog-symbol',
});

const checkpoint = (asset: AssetRef, amount: string): FeedCheckpoint => ({
  asset,
  at: CAPTURED,
  amount,
  authority: 'provider',
  legacySource: 'sync-capture',
  legacyMeta: UPDATE_ORIGIN,
});

function balances(
  owner: { userId: string; accountId: string },
  checkpoints: FeedCheckpoint[],
  legacy: Partial<LegacyBatchOptions> = {}
): FeedBatch {
  return {
    userId: owner.userId,
    input: {
      accountId: owner.accountId,
      source: 'provider:snapshots-test',
      credentialId: null,
      walletId: null,
    },
    fetchedAt: FETCHED,
    window: { shape: 'balance-snapshot', from: CAPTURED, to: FETCHED, complete: false },
    checkpoints,
    entries: [],
    absences: [],
    legacy: {
      holdingMatch: 'external-id',
      holdingPolicy: 'create',
      holdingSource: TAG,
      arrival: 'user_confirmed',
      writesCache: true,
      createdWithoutCheckpoint: 'zero',
      derivesTradeLegs: false,
      holdingFailure: 'skip-entry',
      absence: null,
      clearsAbsenceTally: false,
      createdCheckpointMeta: CREATE_STAMP,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
      ...legacy,
    },
    notices: [],
  };
}

async function owner(tx: DatabaseTransaction) {
  const userId = (await makeUser(tx)).id;
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  return { userId, accountId: account.id };
}

async function holding(
  tx: DatabaseTransaction,
  of: { userId: string; accountId: string },
  fields: {
    tokenId: string;
    balance: string;
    source?: string;
    externalId?: string | null;
    isHidden?: boolean;
    absentFromStatements?: Date[] | null;
  }
) {
  return await makeHolding(tx, {
    userId: of.userId,
    accountId: of.accountId,
    tokenId: fields.tokenId,
    balance: fields.balance,
    source: fields.source ?? TAG,
    externalId: fields.externalId === undefined ? null : fields.externalId,
    isHidden: fields.isHidden ?? false,
    absentFromStatements: fields.absentFromStatements ?? null,
    createdAt: LONG_AGO,
    lastUpdated: LONG_AGO,
  });
}

async function holdingRow(tx: DatabaseTransaction, holdingId: string) {
  const [found] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  if (!found) throw new Error(`holding ${holdingId} is gone`);
  return found;
}

const holdingsOf = (tx: DatabaseTransaction, accountId: string) =>
  tx
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.accountId, accountId))
    .orderBy(asc(schema.holdings.createdAt), asc(schema.holdings.id));

const observationsOf = (tx: DatabaseTransaction, holdingId: string) =>
  tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
    .orderBy(asc(schema.holdingBalanceObservations.observedAt));

describe('FeedIngestService.ingest — external-id, the integration import’s match (F3)', () => {
  test("finds the account's holding of the token at the key, hidden ones included, and never a row without one", async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const manual = await holding(tx, fixture, {
        tokenId: token.id,
        balance: '9',
        source: 'manual',
      });
      const keyed = await holding(tx, fixture, {
        tokenId: token.id,
        balance: '1',
        externalId: 'KEY',
        isHidden: true,
      });

      const result = await ingest(
        balances(fixture, [
          checkpoint(catalog(token.symbol, 'KEY'), '2'),
          checkpoint(catalog(token.symbol, 'OTHER'), '3'),
        ]),
        tx
      );

      const rows = await holdingsOf(tx, fixture.accountId);
      const opened = rows.find((r) => r.externalId === 'OTHER');
      expect(opened).toBeDefined();
      const byId = (id: string) => rows.find((r) => r.id === id);
      expect(rows).toHaveLength(3);
      expect([byId(manual.id)?.balance, byId(keyed.id)?.balance, opened!.balance]).toEqual([
        '9',
        '2',
        '3',
      ]);
      expect(result.checkpointOutcomes).toEqual([
        { tokenId: token.id, holdingId: keyed.id, created: false, failure: null },
        { tokenId: token.id, holdingId: opened!.id, created: true, failure: null },
      ]);
    });
  });
});

describe('FeedIngestService.ingest — a balance batch’s legacy options', () => {
  test('a holding the batch opens takes createdCheckpointMeta on its first checkpoint; one it finds keeps its own', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const [found, opened] = [
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
      ];
      const existing = await holding(tx, fixture, {
        tokenId: found.id,
        balance: '1',
        externalId: 'FOUND',
      });

      const result = await ingest(
        balances(fixture, [
          checkpoint(catalog(found.symbol, 'FOUND'), '2'),
          checkpoint(catalog(opened.symbol, 'OPENED'), '3'),
        ]),
        tx
      );

      const created = result.checkpointOutcomes[1]!.holdingId!;
      const metaOf = async (id: string) =>
        (await observationsOf(tx, id)).map((o) => [o.balance, o.observedAt, o.sourceMetadata]);
      expect(await metaOf(existing.id)).toEqual([['2', CAPTURED, UPDATE_ORIGIN]]);
      expect(await metaOf(created)).toEqual([['3', CAPTURED, CREATE_STAMP]]);
    });
  });

  test("a hidden holding reported nonzero stays hidden: the hide is its owner's (A5 #9)", async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const hidden = await holding(tx, fixture, {
        tokenId: token.id,
        balance: '1',
        externalId: 'HID',
        isHidden: true,
      });
      await ingest(balances(fixture, [checkpoint(catalog(token.symbol, 'HID'), '5')]), tx);
      expect((await holdingRow(tx, hidden.id)).isHidden).toBe(true);
    });
  });

  test('an unchanged balance under skip is placed, not appended and not written, and its holding still counts as reported', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const [steady, moved] = [
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
      ];
      const rows = {
        steady: await holding(tx, fixture, {
          tokenId: steady.id,
          balance: '5',
          absentFromStatements: [new Date('2026-09-19T05:00:00Z')],
        }),
        moved: await holding(tx, fixture, { tokenId: moved.id, balance: '7' }),
      };
      // Its 5 is walked, not read: a checkpoint of 3 and an entry of 2 after
      // it. A reading that agrees adds nothing the engine does not have.
      await makeCheckpoint(tx, {
        userId: fixture.userId,
        holdingId: rows.steady.id,
        observedAt: LONG_AGO,
        balance: '3',
      });
      await makeHoldingTransaction(tx, {
        userId: fixture.userId,
        holdingId: rows.steady.id,
        kind: 'deposit',
        quantity: '2',
        occurredAt: new Date('2026-09-01T00:00:00Z'),
      });

      const result = await ingest(
        balances(
          fixture,
          [checkpoint(catalog(steady.symbol), '5'), checkpoint(catalog(moved.symbol), '8')],
          {
            holdingMatch: 'ingest-order',
            unchangedCheckpoint: 'skip',
            clearsAbsenceTally: true,
            absence: {
              mode: 'confirmed',
              guardEmptySnapshot: true,
              confirmations: null,
              providerRows: 2,
              statementAsOf: CAPTURED,
            },
          }
        ),
        tx
      );

      const steadyAfter = await holdingRow(tx, rows.steady.id);
      expect([
        steadyAfter.balance,
        steadyAfter.lastUpdated,
        steadyAfter.absentFromStatements,
      ]).toEqual(['5', LONG_AGO, null]);
      expect((await observationsOf(tx, rows.steady.id)).map((o) => o.balance)).toEqual(['3']);
      expect(result.zeroedHoldingIds).toEqual([]);
      expect(result.checkpointsWritten).toBe(1);
      expect((await holdingRow(tx, rows.moved.id)).balance).toBe('8');
      expect((await observationsOf(tx, rows.moved.id)).map((o) => o.balance)).toEqual(['8']);
      expect(result.holdings.map((h) => [h.holdingId, h.cacheBalance])).toEqual([
        [rows.steady.id, null],
        [rows.moved.id, '8'],
      ]);
    });
  });

  test('an unchanged balance under append is appended and written', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const steady = await holding(tx, fixture, { tokenId: token.id, balance: '5' });

      await ingest(
        balances(fixture, [checkpoint(catalog(token.symbol), '5')], {
          holdingMatch: 'ingest-order',
        }),
        tx
      );

      expect((await holdingRow(tx, steady.id)).lastUpdated > LONG_AGO).toBe(true);
      expect((await observationsOf(tx, steady.id)).map((o) => o.balance)).toEqual(['5']);
    });
  });

  test('a checkpoint whose holding update-only cannot find is named in the notices (T10 M6)', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const held = await makeToken(tx, { symbol: freshSymbol() });
      const unheld = await makeToken(tx, { symbol: freshSymbol() });
      const existing = await holding(tx, fixture, { tokenId: held.id, balance: '1' });
      // An identity the catalog lacks: update-only still creates the token,
      // as the refresh does today, and never a holding for it.
      const unknownSymbol = freshSymbol();
      const unknown: AssetRef = {
        identity: { symbol: unknownSymbol, name: unknownSymbol },
        typeCode: 'crypto',
        lookup: 'identity',
      };

      const result = await ingest(
        balances(
          fixture,
          [
            checkpoint(catalog(held.symbol), '2'),
            checkpoint(catalog(unheld.symbol), '3'),
            checkpoint(unknown, '4'),
          ],
          { holdingMatch: 'ingest-order', holdingPolicy: 'update-only' }
        ),
        tx
      );

      const [created] = await tx
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, unknownSymbol));
      expect(created).toBeDefined();
      expect((await holdingsOf(tx, fixture.accountId)).map((r) => [r.id, r.balance])).toEqual([
        [existing.id, '2'],
      ]);
      expect(result.checkpointOutcomes).toEqual([
        { tokenId: held.id, holdingId: existing.id, created: false, failure: null },
        { tokenId: unheld.id, holdingId: null, created: false, failure: null },
        { tokenId: created!.id, holdingId: null, created: false, failure: null },
      ]);
      expect(result.notices).toEqual([
        `Skipped 2 balance(s) the account holds no position for, because this sync never opens one: ${unheld.symbol}, ${unknownSymbol}.`,
      ]);
      expect(result.skippedAssets).toEqual([]);
    });
  });

  test('a create batch drops no checkpoint for want of a holding, and says nothing', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const result = await ingest(
        balances(fixture, [checkpoint(catalog(token.symbol, 'NEW'), '3')]),
        tx
      );
      expect(result.notices).toEqual([]);
      expect(result.checkpointOutcomes[0]!.created).toBe(true);
    });
  });
});

describe('FeedIngestService.ingest — zeroOpensHolding, the balance syncs’ zero (Task 16)', () => {
  test('false: a zero opens no holding, though its token resolves and a held one takes it; beside a nonzero of its token it opens', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const [held, unheld, both] = [
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
      ];
      const existing = await holding(tx, fixture, {
        tokenId: held.id,
        balance: '4',
        externalId: 'HELD',
      });

      const result = await ingest(
        balances(
          fixture,
          [
            checkpoint(catalog(held.symbol, 'HELD'), '0'),
            checkpoint(catalog(unheld.symbol, 'UNHELD'), '0'),
            checkpoint(catalog(both.symbol, 'BOTH'), '0'),
            { ...checkpoint(catalog(both.symbol, 'BOTH'), '2'), at: FETCHED },
          ],
          { zeroOpensHolding: false }
        ),
        tx
      );

      const rows = await holdingsOf(tx, fixture.accountId);
      const opened = rows.find((r) => r.tokenId === both.id);
      expect(rows.map((r) => [r.tokenId, r.balance])).toEqual([
        [held.id, '0'],
        [both.id, '2'],
      ]);
      expect(result.checkpointOutcomes).toEqual([
        { tokenId: held.id, holdingId: existing.id, created: false, failure: null },
        { tokenId: unheld.id, holdingId: null, created: false, failure: null },
        { tokenId: both.id, holdingId: opened!.id, created: true, failure: null },
        { tokenId: both.id, holdingId: opened!.id, created: true, failure: null },
      ]);
      expect(result.notices).toEqual([]);
    });
  });

  test('true: a zero opens a holding at zero', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const unheld = await makeToken(tx, { symbol: freshSymbol() });

      const result = await ingest(
        balances(fixture, [checkpoint(catalog(unheld.symbol, 'UNHELD'), '0')], {
          zeroOpensHolding: true,
        }),
        tx
      );

      const rows = await holdingsOf(tx, fixture.accountId);
      expect(rows.map((r) => [r.tokenId, r.balance, r.externalId])).toEqual([
        [unheld.id, '0', 'UNHELD'],
      ]);
      expect(result.checkpointOutcomes).toEqual([
        { tokenId: unheld.id, holdingId: rows[0]!.id, created: true, failure: null },
      ]);
    });
  });
});
