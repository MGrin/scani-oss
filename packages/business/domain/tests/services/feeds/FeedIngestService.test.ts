/**
 * `FeedIngestService.ingest`, the one write path every feed import moves onto
 * (foundation A2 D-8). One batch is one transaction: its input, its holdings,
 * its entries, its checkpoints, its window, the cache and the holdings' kinds
 * are all written or none is. The cache is written exactly where today's
 * statement import wrote it (D-1): a checkpointed holding takes its latest
 * close, a holding the batch created takes `'0'` or the sum of its rows, and an
 * existing holding with no close keeps its balance.
 *
 * Most tests run inside a rolled-back transaction. Three commit their fixture
 * and let `ingest` open its own transaction, because what they assert is only
 * visible across transactions: `updated_at` is `now()`, which one transaction
 * reads as a single instant; a failed batch's rollback; and the labels the
 * classification backfill reads from committed rows.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { FeedInputRepository } from '../../../src/repositories/FeedInputRepository';
import {
  FeedBatchRejected,
  FeedIngestService,
} from '../../../src/services/feeds/FeedIngestService';
import type {
  AssetRef,
  FeedBatch,
  FeedCheckpoint,
  FeedEntry,
} from '../../../src/services/feeds/feed-batch';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { FoundationClassificationService } from '../../../src/services/foundation/FoundationClassificationService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeCheckpoint,
  makeHolding,
  makeToken,
} from '../../../test/helpers/factories-extra';
import { expectLabelsSettled } from '../../../test/helpers/labels-settled';

const ingest = (batch: FeedBatch, tx?: DatabaseTransaction) =>
  Container.get(FeedIngestService).ingest(batch, tx);

const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const T0 = new Date('2026-07-20T00:00:00Z');
const T1 = new Date('2026-08-01T00:00:00Z');
const T2 = new Date('2026-08-05T00:00:00Z');
const T3 = new Date('2026-08-10T00:00:00Z');
const FETCHED = new Date('2026-08-12T09:00:00Z');

const STATEMENT_META = { format: 'csv', bankTemplate: null };

function asset(symbol: string): AssetRef {
  return { identity: { symbol, name: symbol }, typeCode: 'fiat', lookup: 'catalog-symbol' };
}

function row(symbol: string, externalId: string, amount: string, occurredAt: Date): FeedEntry {
  return {
    externalId,
    asset: asset(symbol),
    amount,
    occurredAt,
    counterparty: `payee ${externalId}`,
    legacy: {
      kind: amount.startsWith('-') ? 'withdraw' : 'deposit',
      source: 'statement-csv',
      sourceMetadata: { description: `row ${externalId}`, ...STATEMENT_META },
      rawPayload: { line: externalId },
    },
  };
}

function close(symbol: string, at: Date, amount: string): FeedCheckpoint {
  return {
    asset: asset(symbol),
    at,
    amount,
    authority: 'statement',
    legacySource: 'statement-close',
    legacyMeta: STATEMENT_META,
  };
}

function statement(
  owner: { userId: string; accountId: string },
  fields: Partial<FeedBatch> & Pick<FeedBatch, 'entries' | 'checkpoints'>
): FeedBatch {
  return {
    userId: owner.userId,
    input: { accountId: owner.accountId, source: 'statement', credentialId: null, walletId: null },
    fetchedAt: FETCHED,
    window: { shape: 'statement-upload', from: T1, to: T3, complete: false, uploadRef: 'upload-1' },
    absences: [],
    legacy: {
      holdingMatch: 'account-token',
      holdingPolicy: 'create',
      holdingSource: 'statement-import',
      arrival: 'user_confirmed',
      writesCache: true,
      createdWithoutCheckpoint: 'sum-of-entries',
      derivesTradeLegs: false,
      holdingFailure: 'fail-batch',
      absence: null,
      clearsAbsenceTally: false,
      createdCheckpointMeta: null,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
    },
    notices: [],
    ...fields,
  };
}

/** A user, an account, and one catalog token per symbol asked for. */
async function owner(tx: DatabaseTransaction, symbolCount: number, institutionTypeId?: string) {
  const userId = (await makeUser(tx)).id;
  const institution = await makeInstitution(
    tx,
    institutionTypeId === undefined ? {} : { typeId: institutionTypeId }
  );
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  const tokens = [];
  for (let i = 0; i < symbolCount; i += 1) {
    tokens.push(
      await makeToken(tx, { symbol: `S${randomUUID().replace(/-/g, '').toUpperCase()}` })
    );
  }
  return { userId, accountId: account.id, institutionId: institution.id, tokens };
}

const unknownSymbol = () => `ZZ${randomUUID().replace(/-/g, '').toUpperCase()}`;

const holdingsOf = (tx: DatabaseTransaction, accountId: string) =>
  tx
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.accountId, accountId))
    .orderBy(asc(schema.holdings.createdAt), asc(schema.holdings.id));

async function holdingRow(tx: DatabaseTransaction, holdingId: string) {
  const [found] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  if (!found) throw new Error(`holding ${holdingId} is gone`);
  return found;
}

const ledgerOf = (tx: DatabaseTransaction, userId: string) =>
  tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.userId, userId))
    .orderBy(
      asc(schema.holdingTransactions.occurredAt),
      asc(schema.holdingTransactions.externalId)
    );

const observationsOf = (tx: DatabaseTransaction, holdingId: string) =>
  tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
    .orderBy(asc(schema.holdingBalanceObservations.observedAt));

const inputsOf = (tx: DatabaseTransaction, accountId: string) =>
  tx.select().from(schema.feedInputs).where(eq(schema.feedInputs.accountId, accountId));

const windowsOf = (tx: DatabaseTransaction, inputIds: readonly string[]) =>
  inputIds.length === 0
    ? Promise.resolve([])
    : tx
        .select()
        .from(schema.feedInputWindows)
        .where(inArray(schema.feedInputWindows.inputId, [...inputIds]))
        .orderBy(asc(schema.feedInputWindows.fetchedAt));

const copiesOf = (tx: DatabaseTransaction, userId: string) =>
  tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(
      and(
        eq(schema.holdingBalanceObservations.userId, userId),
        eq(schema.holdingBalanceObservations.source, 'sync-capture'),
        sql`${schema.holdingBalanceObservations.sourceMetadata}->>'origin' = 'updateHoldingBalance'`
      )
    )
    .orderBy(asc(schema.holdingBalanceObservations.observedAt));

describe('FeedIngestService.ingest', () => {
  test('ingests a statement-shaped batch: entries, a statement checkpoint, the window, and the cache set to the close', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 1);
      const eur = fixture.tokens[0]!.symbol;
      const fee: FeedEntry = {
        ...row(eur, 'r2:fee', '-1.5', T2),
        legacy: {
          kind: 'fee',
          source: 'statement-csv',
          sourceMetadata: {
            description: 'Fee — row r2',
            ...STATEMENT_META,
            feeForExternalId: 'r2',
          },
        },
      };
      const batch = statement(fixture, {
        entries: [
          row(eur, 'r1', '1000', T1),
          row(eur, 'r2', '-49.5', T2),
          fee,
          row(eur, 'r3', '300', T3),
        ],
        checkpoints: [close(eur, T3, '1249')],
      });

      const result = await ingest(batch, tx);

      const [input] = await inputsOf(tx, fixture.accountId);
      const [holding] = await holdingsOf(tx, fixture.accountId);
      expect(result).toEqual({
        userId: fixture.userId,
        inputId: input!.id,
        touchedHoldingIds: [holding!.id],
        createdHoldingIds: [holding!.id],
        earliestChangedAt: T1,
        notices: [],
        noticeDetails: [],
        entryOutcomes: ['landed', 'landed', 'landed', 'landed'],
        rowsSent: 4,
        entriesWritten: 4,
        insertedEntryIds: expect.any(Array),
        merges: [],
        checkpointsWritten: 1,
        windowRecorded: true,
        mirrorHoldingIds: [],
        zeroedHoldingIds: [],
        skippedAssets: [],
        checkpointOutcomes: [
          { tokenId: fixture.tokens[0]!.id, holdingId: holding!.id, created: true, failure: null },
        ],
        holdings: [
          { holdingId: holding!.id, tokenId: fixture.tokens[0]!.id, cacheBalance: '1249' },
        ],
      });
      expect(result.insertedEntryIds).toHaveLength(4);
      expect(await ingest(batch, tx).then((again) => again.insertedEntryIds)).toEqual([]);
      expect({
        userId: input!.userId,
        source: input!.source,
        credentialId: input!.credentialId,
        walletId: input!.walletId,
        status: input!.status,
      }).toEqual({
        userId: fixture.userId,
        source: 'statement',
        credentialId: null,
        walletId: null,
        status: 'active',
      });

      expect({
        tokenId: holding!.tokenId,
        kind: holding!.kind,
        startsAt: holding!.startsAt,
        balance: holding!.balance,
        source: holding!.source,
        arrival: holding!.arrival,
        externalId: holding!.externalId,
      }).toEqual({
        tokenId: fixture.tokens[0]!.id,
        kind: 'feed',
        startsAt: T1,
        balance: '1249',
        source: 'statement-import',
        arrival: 'user_confirmed',
        externalId: null,
      });

      const ledger = await ledgerOf(tx, fixture.userId);
      expect(
        ledger.map((r) => ({
          holdingId: r.holdingId,
          externalId: r.externalId,
          kind: r.kind,
          quantity: r.quantity,
          source: r.source,
          inputId: r.inputId,
          counterparty: r.counterparty,
          ledgerKind: r.ledgerKind,
          kindOrigin: r.kindOrigin,
        }))
      ).toEqual([
        {
          holdingId: holding!.id,
          externalId: 'r1',
          kind: 'deposit',
          quantity: '1000',
          source: 'statement-csv',
          inputId: input!.id,
          counterparty: 'payee r1',
          ledgerKind: 'inflow',
          kindOrigin: 'source',
        },
        {
          holdingId: holding!.id,
          externalId: 'r2',
          kind: 'withdraw',
          quantity: '-49.5',
          source: 'statement-csv',
          inputId: input!.id,
          counterparty: 'payee r2',
          ledgerKind: 'outflow',
          kindOrigin: 'source',
        },
        {
          holdingId: holding!.id,
          externalId: 'r2:fee',
          kind: 'fee',
          quantity: '-1.5',
          source: 'statement-csv',
          inputId: input!.id,
          counterparty: 'payee r2:fee',
          ledgerKind: 'fee',
          kindOrigin: 'source',
        },
        {
          holdingId: holding!.id,
          externalId: 'r3',
          kind: 'deposit',
          quantity: '300',
          source: 'statement-csv',
          inputId: input!.id,
          counterparty: 'payee r3',
          ledgerKind: 'inflow',
          kindOrigin: 'source',
        },
      ]);
      expect(ledger[2]?.sourceMetadata).toEqual({
        description: 'Fee — row r2',
        ...STATEMENT_META,
        feeForExternalId: 'r2',
      });
      expect(ledger[0]?.rawPayload).toEqual({ line: 'r1' });

      // The one observation is the close itself: no copy of the balance at now.
      const observations = await observationsOf(tx, holding!.id);
      expect(
        observations.map((o) => ({
          balance: o.balance,
          observedAt: o.observedAt,
          source: o.source,
          sourceMetadata: o.sourceMetadata,
          role: o.role,
          authority: o.authority,
          inputId: o.inputId,
          cause: o.cause,
        }))
      ).toEqual([
        {
          balance: '1249',
          observedAt: T3,
          source: 'statement-close',
          sourceMetadata: STATEMENT_META,
          role: 'checkpoint',
          authority: 'statement',
          inputId: input!.id,
          cause: null,
        },
      ]);

      const windows = await windowsOf(tx, [input!.id]);
      expect(
        windows.map((w) => ({
          fromAt: w.fromAt,
          toAt: w.toAt,
          complete: w.complete,
          fetchedAt: w.fetchedAt,
          uploadRef: w.uploadRef,
        }))
      ).toEqual([
        { fromAt: T1, toAt: T3, complete: false, fetchedAt: FETCHED, uploadRef: 'upload-1' },
      ]);
    });
  });

  test('a rejected batch writes nothing', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 1);
      const eur = fixture.tokens[0]!.symbol;
      const batch = statement(fixture, {
        entries: [row(eur, 'r1', '1000', T1), row(eur, '', '5', T2)],
        checkpoints: [close(eur, FETCHED, '1005')],
      });

      const rejected = await ingest(batch, tx).catch((error: unknown) => error);

      expect(rejected).toBeInstanceOf(FeedBatchRejected);
      expect((rejected as FeedBatchRejected).problems.map((p) => p.code)).toEqual([
        'empty-external-id',
        'checkpoint-outside-window',
      ]);
      expect(await inputsOf(tx, fixture.accountId)).toEqual([]);
      expect(await holdingsOf(tx, fixture.accountId)).toEqual([]);
      expect(await ledgerOf(tx, fixture.userId)).toEqual([]);
    });
  });

  test("a batch naming another user's account is refused before its input or holdings exist", async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 1);
      const stranger = await owner(tx, 0);
      const eur = fixture.tokens[0]!.symbol;
      const batchOn = (accountId: string) =>
        statement(
          { userId: fixture.userId, accountId },
          { entries: [row(eur, 'r1', '1000', T1)], checkpoints: [close(eur, T3, '1000')] }
        );

      const refused = await ingest(batchOn(stranger.accountId), tx).catch(
        (error: unknown) => error
      );

      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toBe(
        `FeedIngestService: user ${fixture.userId} has no account ${stranger.accountId}`
      );
      expect(await inputsOf(tx, stranger.accountId)).toEqual([]);
      expect(await holdingsOf(tx, stranger.accountId)).toEqual([]);
      expect(await ledgerOf(tx, fixture.userId)).toEqual([]);

      // The control: the same batch on the user's own account is written.
      const written = await ingest(batchOn(fixture.accountId), tx);
      expect(written.entriesWritten).toBe(1);
      expect((await inputsOf(tx, fixture.accountId)).map((i) => i.id)).toEqual([written.inputId]);
    });
  });

  test('an unknown currency is skipped and reported, and the rest is written', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 1);
      const eur = fixture.tokens[0]!.symbol;
      const unknown = unknownSymbol();
      const batch = statement(fixture, {
        entries: [
          row(eur, 'r1', '1000', T1),
          row(unknown, 'r2', '70', T2),
          row(unknown, 'r3', '-20', T2),
          row(eur, 'r4', '-100', T3),
        ],
        checkpoints: [close(eur, T3, '900')],
      });

      const result = await ingest(batch, tx);

      expect(result.skippedAssets).toEqual([
        { symbol: unknown, reason: `no catalog token has the symbol ${unknown}` },
      ]);
      const holdings = await holdingsOf(tx, fixture.accountId);
      expect(holdings.map((h) => ({ tokenId: h.tokenId, balance: h.balance }))).toEqual([
        { tokenId: fixture.tokens[0]!.id, balance: '900' },
      ]);
      expect((await ledgerOf(tx, fixture.userId)).map((r) => r.externalId)).toEqual(['r1', 'r4']);
      expect(result.entriesWritten).toBe(2);
      expect(result.checkpointsWritten).toBe(1);
      expect(result.windowRecorded).toBe(true);
    });
  });

  test('a checkpoint in an unknown currency is skipped with it', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 1);
      const eur = fixture.tokens[0]!.symbol;
      const unknown = unknownSymbol();
      const result = await ingest(
        statement(fixture, {
          entries: [row(eur, 'r1', '1000', T1), row(unknown, 'r2', '70', T3)],
          checkpoints: [close(unknown, T3, '70')],
        }),
        tx
      );

      expect(result.skippedAssets).toEqual([
        { symbol: unknown, reason: `no catalog token has the symbol ${unknown}` },
      ]);
      expect(result.checkpointsWritten).toBe(0);
      const [holding] = await holdingsOf(tx, fixture.accountId);
      expect(holding?.balance).toBe('1000');
      expect(await observationsOf(tx, holding!.id)).toEqual([]);
    });
  });

  test('a created holding with no close takes the sum of its rows, a negative one included (A5: no floor)', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 2);
      const [gains, spends] = fixture.tokens.map((t) => t.symbol) as [string, string];
      const result = await ingest(
        statement(fixture, {
          entries: [
            row(gains, 'g1', '3200', T1),
            row(gains, 'g2', '-1100', T2),
            row(gains, 'g3', '-84.20', T3),
            row(spends, 's1', '-1100', T1),
            row(spends, 's2', '-84.20', T2),
          ],
          checkpoints: [],
        }),
        tx
      );

      const byToken = new Map(
        (await holdingsOf(tx, fixture.accountId)).map((h) => [h.tokenId, h.balance])
      );
      expect(byToken.get(fixture.tokens[0]!.id)).toBe('2015.8');
      expect(byToken.get(fixture.tokens[1]!.id)).toBe('-1184.2');
      expect(result.createdHoldingIds).toHaveLength(2);
      expect(result.checkpointsWritten).toBe(0);
    });
  });

  test("with createdWithoutCheckpoint 'zero', a created holding with no close still takes the sum of its rows: the option sets only what the import expected (A5 D-1)", async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 1);
      const eur = fixture.tokens[0]!.symbol;
      const batch = statement(fixture, {
        entries: [row(eur, 'r1', '500', T1)],
        checkpoints: [],
      });
      await ingest({ ...batch, legacy: { ...batch.legacy, createdWithoutCheckpoint: 'zero' } }, tx);

      const [holding] = await holdingsOf(tx, fixture.accountId);
      expect(holding?.balance).toBe('500');
    });
  });

  test('an existing holding with no close takes its rows after its last checkpoint, and keeps its last_updated (A5 D-18)', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 1);
      const existing = await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: fixture.tokens[0]!.id,
        balance: '500',
        kind: 'feed',
        startsAt: LONG_AGO,
        lastUpdated: LONG_AGO,
      });
      await makeCheckpoint(tx, {
        userId: fixture.userId,
        holdingId: existing.id,
        observedAt: LONG_AGO,
        balance: '500',
      });

      const result = await ingest(
        statement(fixture, {
          entries: [row(fixture.tokens[0]!.symbol, 'r1', '10', T1)],
          checkpoints: [],
        }),
        tx
      );

      const after = await holdingRow(tx, existing.id);
      expect({ balance: after.balance, lastUpdated: after.lastUpdated }).toEqual({
        balance: '510',
        lastUpdated: LONG_AGO,
      });
      expect(result.createdHoldingIds).toEqual([]);
      expect(result.touchedHoldingIds).toEqual([existing.id]);
    });
  });

  test("a batch that writes no cache still brings a checkpointed holding to the engine's figure, and keeps its last_updated (A5 D-18)", async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 1);
      const existing = await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: fixture.tokens[0]!.id,
        balance: '500',
        kind: 'feed',
        startsAt: LONG_AGO,
        lastUpdated: LONG_AGO,
      });
      const batch = statement(fixture, {
        entries: [row(fixture.tokens[0]!.symbol, 'r1', '10', T1)],
        checkpoints: [close(fixture.tokens[0]!.symbol, T3, '510')],
      });

      await ingest({ ...batch, legacy: { ...batch.legacy, writesCache: false } }, tx);

      const after = await holdingRow(tx, existing.id);
      expect({ balance: after.balance, lastUpdated: after.lastUpdated }).toEqual({
        balance: '510',
        lastUpdated: LONG_AGO,
      });
      expect((await observationsOf(tx, existing.id)).map((o) => o.balance)).toEqual(['510']);
    });
  });

  test('an existing manual holding the statement writes into becomes feed, and its earlier person values keep role snapshot while later ones become verification', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 1);
      const manual = await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: fixture.tokens[0]!.id,
        balance: '950',
        source: 'manual',
        kind: 'snapshot',
        startsAt: LONG_AGO,
        lastUpdated: LONG_AGO,
      });
      // Typed before the statement's first row (T1), and after it.
      for (const [observedAt, balance, origin] of [
        [T0, '900', 'createHoldingWithEvent'],
        [T2, '950', 'updateHolding'],
      ] as const) {
        await tx.insert(schema.holdingBalanceObservations).values({
          userId: fixture.userId,
          holdingId: manual.id,
          balance,
          observedAt,
          source: 'sync-capture',
          sourceMetadata: { origin, source: 'manual' },
          role: 'snapshot',
          authority: 'person',
          cause: 'flow',
        });
      }
      const eur = fixture.tokens[0]!.symbol;

      const result = await ingest(
        statement(fixture, {
          entries: [row(eur, 'r1', '100', T1), row(eur, 'r2', '-30', T3)],
          checkpoints: [close(eur, T3, '1020')],
        }),
        tx
      );

      const after = await holdingRow(tx, manual.id);
      expect({ kind: after.kind, startsAt: after.startsAt, balance: after.balance }).toEqual({
        kind: 'feed',
        startsAt: LONG_AGO,
        balance: '1020',
      });
      expect(
        (await observationsOf(tx, manual.id)).map((o) => ({
          observedAt: o.observedAt,
          balance: o.balance,
          role: o.role,
          authority: o.authority,
          cause: o.cause,
        }))
      ).toEqual([
        { observedAt: T0, balance: '900', role: 'snapshot', authority: 'person', cause: 'flow' },
        {
          observedAt: T2,
          balance: '950',
          role: 'verification',
          authority: 'person',
          cause: 'flow',
        },
        {
          observedAt: T3,
          balance: '1020',
          role: 'checkpoint',
          authority: 'statement',
          cause: null,
        },
      ]);
      expect(result.createdHoldingIds).toEqual([]);
      expect(result.touchedHoldingIds).toEqual([manual.id]);
    });
  });

  test("an existing holding's starts_at is lowered to the batch's earliest evidence, and a NULL one stays NULL", async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 2);
      const [late, unknownStart] = [
        await makeHolding(tx, {
          userId: fixture.userId,
          accountId: fixture.accountId,
          tokenId: fixture.tokens[0]!.id,
          kind: 'feed',
          startsAt: T3,
        }),
        await makeHolding(tx, {
          userId: fixture.userId,
          accountId: fixture.accountId,
          tokenId: fixture.tokens[1]!.id,
          kind: 'feed',
          startsAt: null,
        }),
      ];
      const [a, b] = fixture.tokens.map((t) => t.symbol) as [string, string];

      await ingest(
        statement(fixture, {
          entries: [row(a, 'a1', '5', T2), row(b, 'b1', '5', T1)],
          checkpoints: [close(a, T1, '1')],
        }),
        tx
      );

      expect((await holdingRow(tx, late.id)).startsAt).toEqual(T1);
      expect((await holdingRow(tx, unknownStart.id)).startsAt).toBeNull();
    });
  });

  test('a statement batch appends no copy beside its cache writes: the engine reads the close (A5 D-19)', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 3);
      const [closed, summed, negative] = fixture.tokens.map((t) => t.symbol) as [
        string,
        string,
        string,
      ];

      const result = await ingest(
        statement(fixture, {
          entries: [
            row(closed, 'c1', '100', T1),
            row(summed, 's1', '70', T2),
            row(negative, 'n1', '-5', T2),
          ],
          checkpoints: [close(closed, T3, '120')],
        }),
        tx
      );

      const balanceOf = new Map(
        (await holdingsOf(tx, fixture.accountId)).map((h) => [h.tokenId, h.balance])
      );
      expect(fixture.tokens.map((t) => balanceOf.get(t.id))).toEqual(['120', '70', '-5']);
      expect(await copiesOf(tx, fixture.userId)).toEqual([]);
      expect(result.checkpointsWritten).toBe(1);
    });
  });

  test('a new input is created once per (account, source)', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx, 1);
      const eur = fixture.tokens[0]!.symbol;
      const first = await ingest(
        statement(fixture, { entries: [row(eur, 'r1', '10', T1)], checkpoints: [] }),
        tx
      );
      const second = await ingest(
        statement(fixture, {
          fetchedAt: new Date(FETCHED.getTime() + 60_000),
          window: {
            shape: 'statement-upload',
            from: T2,
            to: T3,
            complete: false,
            uploadRef: 'upload-2',
          },
          entries: [row(eur, 'r2', '20', T3)],
          checkpoints: [],
        }),
        tx
      );
      const otherSource = await ingest(
        {
          ...statement(fixture, { entries: [row(eur, 'r3', '30', T3)], checkpoints: [] }),
          input: {
            accountId: fixture.accountId,
            source: 'statement-camt',
            credentialId: null,
            walletId: null,
          },
        },
        tx
      );
      const otherAccount = await makeAccount(tx, {
        userId: fixture.userId,
        institutionId: fixture.institutionId,
      });
      const elsewhere = await ingest(
        statement(
          { userId: fixture.userId, accountId: otherAccount.id },
          { entries: [row(eur, 'r4', '40', T3)], checkpoints: [] }
        ),
        tx
      );

      const inputs = await inputsOf(tx, fixture.accountId);
      expect(inputs.map((i) => i.source).sort()).toEqual(['statement', 'statement-camt']);
      const statementInput = inputs.find((i) => i.source === 'statement')!;
      expect([first.inputId, second.inputId]).toEqual([statementInput.id, statementInput.id]);
      expect(otherSource.inputId).not.toBe(statementInput.id);
      expect((await inputsOf(tx, otherAccount.id)).map((i) => i.id)).toEqual([elsewhere.inputId]);
      expect((await windowsOf(tx, [statementInput.id])).map((w) => w.uploadRef)).toEqual([
        'upload-1',
        'upload-2',
      ]);
    });
  });
});

describe('FeedIngestService.ingest, committed', () => {
  const createdUserIds: string[] = [];
  const createdTokenIds: string[] = [];
  const createdInstitutionIds: string[] = [];
  let stubbed: ReturnType<typeof spyOn> | null = null;

  afterEach(async () => {
    stubbed?.mockRestore();
    stubbed = null;
    const db = getDb();
    const users = createdUserIds.splice(0);
    const tokens = createdTokenIds.splice(0);
    const institutions = createdInstitutionIds.splice(0);
    // Users first: their holdings are what keep the tokens restricted.
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    if (tokens.length) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
    if (institutions.length) {
      await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
    }
  });

  async function seed(symbolCount: number) {
    return await getDb().transaction(async (tx) => {
      // The seeded type, upserted, so no `institution_types` row outlives the test.
      const bank = await makeInstitutionType(tx, { code: 'bank' });
      const fixture = await owner(tx, symbolCount, bank.id);
      createdUserIds.push(fixture.userId);
      createdTokenIds.push(...fixture.tokens.map((t) => t.id));
      createdInstitutionIds.push(fixture.institutionId);
      return fixture;
    });
  }

  const read = <T>(fn: (tx: DatabaseTransaction) => Promise<T>) => getDb().transaction(fn);

  test('replaying the same batch changes nothing', async () => {
    const fixture = await seed(1);
    const eur = fixture.tokens[0]!.symbol;
    const batch = statement(fixture, {
      entries: [row(eur, 'r1', '1000', T1), row(eur, 'r2', '-49.5', T2)],
      checkpoints: [close(eur, T3, '950.5')],
    });

    const first = await ingest(batch);
    const snapshot = () =>
      read(async (tx) => {
        const [holding] = await holdingsOf(tx, fixture.accountId);
        return {
          ledger: (await ledgerOf(tx, fixture.userId)).map((r) => ({
            id: r.id,
            updatedAt: r.updatedAt,
            ledgerKind: r.ledgerKind,
            inputId: r.inputId,
          })),
          holdings: (await holdingsOf(tx, fixture.accountId)).map((h) => h.id),
          observations: (await observationsOf(tx, holding!.id)).map((o) => o.id),
          inputs: (await inputsOf(tx, fixture.accountId)).map((i) => i.id),
          windows: (await windowsOf(tx, [first.inputId])).map((w) => w.id),
          balance: holding!.balance,
        };
      });
    const before = await snapshot();
    expect(before.windows).toHaveLength(1);

    const second = await ingest(batch);

    // The cache is written again, as a re-upload always wrote it (D-1); the
    // figure it writes is the one already there.
    expect(await snapshot()).toEqual(before);
    expect({
      inputId: second.inputId,
      createdHoldingIds: second.createdHoldingIds,
      checkpointsWritten: second.checkpointsWritten,
      windowRecorded: second.windowRecorded,
      earliestChangedAt: second.earliestChangedAt,
    }).toEqual({
      inputId: first.inputId,
      createdHoldingIds: [],
      checkpointsWritten: 0,
      windowRecorded: false,
      earliestChangedAt: null,
    });
  });

  test('a batch that fails at the window insert leaves no entry, checkpoint or cache change', async () => {
    const fixture = await seed(2);
    const [kept, fresh] = fixture.tokens;
    const existing = await getDb().transaction((tx) =>
      makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: kept!.id,
        balance: '500',
        source: 'manual',
        kind: 'snapshot',
        startsAt: LONG_AGO,
        lastUpdated: LONG_AGO,
      })
    );
    stubbed = spyOn(Container.get(FeedInputRepository), 'recordWindow').mockRejectedValue(
      new Error('window insert failed')
    );

    await expect(
      ingest(
        statement(fixture, {
          entries: [row(kept!.symbol, 'r1', '100', T1), row(fresh!.symbol, 'r2', '7', T2)],
          checkpoints: [close(kept!.symbol, T3, '600')],
        })
      )
    ).rejects.toThrow('window insert failed');
    expect(stubbed).toHaveBeenCalledTimes(1);

    await read(async (tx) => {
      expect(await ledgerOf(tx, fixture.userId)).toEqual([]);
      expect(await observationsOf(tx, existing.id)).toEqual([]);
      expect(await inputsOf(tx, fixture.accountId)).toEqual([]);
      expect((await holdingsOf(tx, fixture.accountId)).map((h) => h.id)).toEqual([existing.id]);
    });
  });

  // The window is written before the cache, the kind and `starts_at`, so only a
  // failure after all three can show that a rollback takes them back.
  test('a batch that fails at its last write rolls back the cache, the kind flip and the lowered starts_at', async () => {
    const fixture = await seed(1);
    const existing = await getDb().transaction((tx) =>
      makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: fixture.tokens[0]!.id,
        balance: '500',
        source: 'manual',
        kind: 'snapshot',
        startsAt: FETCHED,
        lastUpdated: LONG_AGO,
      })
    );
    const duringFailure: Array<Pick<schema.Holding, 'balance' | 'kind' | 'startsAt'>> = [];
    // The cache is the batch's last write, and revaluing it is the last step
    // of that write (A5 D-15). The unhide step revalues first, with no holding.
    stubbed = spyOn(Container.get(HoldingCacheWriter), 'revalue').mockImplementation(
      async (_userId, ids, _at, tx) => {
        if (!ids.includes(existing.id)) return [];
        const { balance, kind, startsAt } = await holdingRow(tx, existing.id);
        duringFailure.push({ balance, kind, startsAt });
        throw new Error('revalue failed');
      }
    );
    const symbol = fixture.tokens[0]!.symbol;

    await expect(
      ingest(
        statement(fixture, {
          entries: [row(symbol, 'r1', '100', T1)],
          checkpoints: [close(symbol, T3, '600')],
        })
      )
    ).rejects.toThrow('revalue failed');

    // What the rollback has to undo was written before the failure.
    expect(duringFailure).toEqual([{ balance: '600', kind: 'feed', startsAt: T1 }]);
    const after = await read(async (tx) => {
      const { balance, lastUpdated, kind, startsAt } = await holdingRow(tx, existing.id);
      return {
        holding: { balance, lastUpdated, kind, startsAt },
        ledger: await ledgerOf(tx, fixture.userId),
        observations: await observationsOf(tx, existing.id),
        inputs: await inputsOf(tx, fixture.accountId),
      };
    });
    expect(after).toEqual({
      holding: { balance: '500', lastUpdated: LONG_AGO, kind: 'snapshot', startsAt: FETCHED },
      ledger: [],
      observations: [],
      inputs: [],
    });
  });

  test('expectLabelsSettled after an ingest on a backfilled fixture', async () => {
    const fixture = await seed(2);
    const [manualToken, newToken] = fixture.tokens;
    const manual = await getDb().transaction(async (tx) => {
      const holding = await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: manualToken!.id,
        balance: '900',
        source: 'manual',
        createdAt: T0,
        lastUpdated: T0,
      });
      // Today's manual create: the holding and its creation-time copy, unlabelled.
      for (const [observedAt, balance, origin] of [
        [T0, '900', 'createHoldingWithEvent'],
        [T2, '950', 'updateHolding'],
      ] as const) {
        await tx.insert(schema.holdingBalanceObservations).values({
          userId: fixture.userId,
          holdingId: holding.id,
          balance,
          observedAt,
          source: 'sync-capture',
          sourceMetadata: { origin, source: 'manual' },
        });
      }
      return holding;
    });
    const classification = Container.get(FoundationClassificationService);
    await classification.classify({ apply: true, userId: fixture.userId });
    expect((await read((tx) => holdingRow(tx, manual.id))).kind).toBe('snapshot');

    await ingest(
      statement(fixture, {
        entries: [
          row(manualToken!.symbol, 'm1', '100', T1),
          row(newToken!.symbol, 'n1', '40', T2),
          {
            ...row(manualToken!.symbol, 'm1:fee', '-2', T1),
            legacy: {
              kind: 'fee',
              source: 'statement-csv',
              sourceMetadata: { ...STATEMENT_META, feeForExternalId: 'm1' },
            },
          },
          row(manualToken!.symbol, 'm2', '-30', T3),
        ],
        checkpoints: [close(manualToken!.symbol, T3, '1018')],
      })
    );

    expect((await read((tx) => holdingRow(tx, manual.id))).kind).toBe('feed');
    const roles = await read((tx) =>
      tx
        .select({
          observedAt: schema.holdingBalanceObservations.observedAt,
          role: schema.holdingBalanceObservations.role,
        })
        .from(schema.holdingBalanceObservations)
        .where(
          and(
            eq(schema.holdingBalanceObservations.holdingId, manual.id),
            eq(schema.holdingBalanceObservations.authority, 'person')
          )
        )
        .orderBy(asc(schema.holdingBalanceObservations.observedAt))
    );
    expect(roles).toEqual([
      { observedAt: T0, role: 'snapshot' },
      { observedAt: T2, role: 'verification' },
    ]);
    await expectLabelsSettled(fixture.userId);
  });
});
