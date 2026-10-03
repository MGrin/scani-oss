/**
 * The order `FeedIngestService` takes its locks in (R78). A person's edit takes
 * its holding's row first, with its cache write, and then the per-holding
 * advisory lock that every observation insert takes (the SC-1319 relink
 * trigger). A batch that appended its checkpoint first and wrote the cache
 * after took the two in the opposite order, so a sync and an edit of one
 * holding could each hold what the other waited on, and Postgres failed one of
 * them with 40P01. A batch now locks its existing holdings' rows, in id order,
 * before it writes anything into them.
 *
 * The fixtures are committed and every batch runs in its own transaction,
 * because a lock is only seen from a second one.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { databaseErrorOf } from '../../../src/lib/database-error';
import { FeedInputRepository } from '../../../src/repositories/FeedInputRepository';
import { FeedIngestService } from '../../../src/services/feeds/FeedIngestService';
import type { AssetRef, FeedBatch } from '../../../src/services/feeds/feed-batch';
import {
  legacySnapshotBatch,
  type SnapshotBatchOptions,
} from '../../../src/services/feeds/legacy/snapshot-batch';
import { EXCHANGE_BALANCE_SYNC_SOURCE } from '../../../src/services/holdings/balance-sync-sources';
import { UpdateHoldingUseCase } from '../../../src/use-cases/UpdateHoldingUseCase';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';
import { backendPid, outcomeOf, waitUntilBlocked } from '../../../test/helpers/lock-wait';

const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const CAPTURED = new Date('2026-09-20T08:00:00Z');
const FETCHED = new Date('2026-09-20T09:00:00Z');

/** The hourly exchange sync's options, without its absence policy. */
const EXCHANGE_SYNC: SnapshotBatchOptions = {
  holdingMatch: 'token-id',
  holdingPolicy: 'create',
  holdingSource: EXCHANGE_BALANCE_SYNC_SOURCE,
  arrival: 'auto_discovered',
  holdingFailure: 'skip-entry',
  absence: null,
  clearsAbsenceTally: true,
  unhideOnNonZero: false,
  unchangedCheckpoint: 'skip',
  zeroOpensHolding: false,
};

const created = { users: [] as string[], tokens: [] as string[], institutions: [] as string[] };
let gate: { mockRestore(): void } | null = null;

afterEach(async () => {
  gate?.mockRestore();
  gate = null;
  const db = getDb();
  const users = created.users.splice(0);
  const tokens = created.tokens.splice(0);
  const institutions = created.institutions.splice(0);
  // Users first: their holdings are what keep the tokens restricted.
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (tokens.length) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
  if (institutions.length) {
    await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
  }
});

const catalog = (symbol: string): AssetRef => ({
  identity: { symbol, name: symbol },
  typeCode: 'crypto',
  lookup: 'catalog-symbol',
});

interface Fixture {
  userId: string;
  accountId: string;
  holdings: Array<{ holding: Holding; symbol: string }>;
}

/** One account holding `count` tokens, each in a feed holding at 100, committed. */
async function account(count: number, source = EXCHANGE_BALANCE_SYNC_SOURCE): Promise<Fixture> {
  return await getDb().transaction(async (tx) => {
    const userId = (await makeUser(tx)).id;
    // The seeded type, upserted, so no `institution_types` row outlives the test.
    const bank = await makeInstitutionType(tx, { code: 'bank' });
    const institution = await makeInstitution(tx, { typeId: bank.id });
    const { id: accountId } = await makeAccount(tx, { userId, institutionId: institution.id });
    created.users.push(userId);
    created.institutions.push(institution.id);
    const holdings: Fixture['holdings'] = [];
    for (let i = 0; i < count; i += 1) {
      const symbol = `S${randomUUID().replace(/-/g, '').toUpperCase()}`;
      const token = await makeToken(tx, { symbol });
      created.tokens.push(token.id);
      const holding = await makeHolding(tx, {
        userId,
        accountId,
        tokenId: token.id,
        balance: '100',
        source,
        kind: 'feed',
        startsAt: LONG_AGO,
        createdAt: LONG_AGO,
        lastUpdated: LONG_AGO,
      });
      holdings.push({ holding, symbol });
    }
    return { userId, accountId, holdings };
  });
}

/** One exchange answer, in the order given, as the sync hands it to ingest. */
function syncBatch(
  fixture: Fixture,
  balances: ReadonlyArray<[{ symbol: string }, string]>
): FeedBatch {
  return legacySnapshotBatch({
    userId: fixture.userId,
    input: {
      accountId: fixture.accountId,
      source: 'provider:lock-order-test',
      credentialId: null,
      walletId: null,
    },
    returnedAt: balances.map(() => CAPTURED),
    snapshots: balances.map(([{ symbol }, balance]) => ({
      asset: catalog(symbol),
      balance,
      capturedAt: CAPTURED,
    })),
    absences: [],
    fetchedAt: FETCHED,
    options: EXCHANGE_SYNC,
  });
}

/** One statement row into each holding given, as the statement import sends it. */
function entryBatch(fixture: Fixture, holdings: ReadonlyArray<{ symbol: string }>): FeedBatch {
  return {
    userId: fixture.userId,
    input: {
      accountId: fixture.accountId,
      source: 'statement',
      credentialId: null,
      walletId: null,
    },
    fetchedAt: FETCHED,
    window: { from: LONG_AGO, to: CAPTURED, complete: false, uploadRef: 'upload-1' },
    checkpoints: [],
    entries: holdings.map(({ symbol }, i) => ({
      externalId: `row-${i}`,
      asset: catalog(symbol),
      amount: '7',
      occurredAt: CAPTURED,
      legacy: {
        kind: 'deposit',
        source: 'statement-csv',
        sourceMetadata: { format: 'csv', bankTemplate: null },
        rawPayload: { line: i },
      },
    })),
    absences: [],
    legacy: {
      holdingMatch: 'account-token',
      holdingPolicy: 'create',
      holdingSource: 'statement-import',
      arrival: 'user_confirmed',
      writesCache: true,
      createdWithoutCheckpoint: 'sum-of-entries',
      cacheObservation: null,
      derivesTradeLegs: false,
      holdingFailure: 'fail-batch',
      absence: null,
      clearsAbsenceTally: false,
      createdCheckpointMeta: null,
      unhideOnNonZero: false,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
    },
    notices: [],
  };
}

/** A fresh instance, so it holds the repository the test gates and not one an earlier file left. */
const ingest = (batch: FeedBatch, tx: DatabaseTransaction) =>
  new FeedIngestService().ingest(batch, tx);

const editBalance = (
  fixture: Fixture,
  holdingId: string,
  balance: string,
  tx: DatabaseTransaction
) => Container.get(UpdateHoldingUseCase).execute(holdingId, { balance }, fixture.userId, tx);

/**
 * A latch: `open()` lets every `passed` waiter through. Always opened in a
 * `finally`, so a failed wait cannot leave a transaction holding a lock the
 * cleanup's user delete would then wait on.
 */
function latch() {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, passed };
}

/** Whether another transaction holds the row: NOWAIT refuses (55P03) where it would queue. */
async function rowLocked(holdingId: string): Promise<boolean> {
  try {
    await getDb().transaction((tx) =>
      tx
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(eq(schema.holdings.id, holdingId))
        .for('no key update', { noWait: true })
    );
    return false;
  } catch (error) {
    if (databaseErrorOf(error)?.code === '55P03') return true;
    throw error;
  }
}

/** Whether the advisory lock an observation insert takes on the holding (SC-1319) is free. */
async function observationLockFree(holdingId: string): Promise<boolean> {
  const key = `holding_balance_observations:${holdingId}`;
  return await getDb().transaction(async (tx) => {
    const [row] = await tx.execute<{ free: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS free`
    );
    return row?.free === true;
  });
}

async function observedBalances(holdingId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ balance: schema.holdingBalanceObservations.balance })
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
    .orderBy(asc(schema.holdingBalanceObservations.createdAt));
  return rows.map((row) => row.balance);
}

async function balanceOf(holdingId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ balance: schema.holdings.balance })
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  return row?.balance;
}

describe('FeedIngestService.ingest — its locks against a person’s edit (R78)', () => {
  /**
   * The batch is held where the old order had appended its checkpoint, and so
   * held the advisory lock, but had not yet written the cache, and so did not
   * hold the row: `recordWindow` sits between the two. An edit arriving there
   * took the row, waited on the advisory lock, and the batch's cache write then
   * waited on the edit.
   */
  test('a sync and a balance edit of one feed holding, the edit arriving after the sync’s checkpoint: both commit (no 40P01)', async () => {
    const fixture = await account(1);
    const [{ holding, symbol }] = fixture.holdings as [Fixture['holdings'][number]];
    const atWindow = latch();
    const proceed = latch();
    const inputs = Container.get(FeedInputRepository);
    const recordWindow = inputs.recordWindow.bind(inputs);
    gate = spyOn(inputs, 'recordWindow').mockImplementation(async (...args) => {
      atWindow.open();
      await proceed.passed;
      return await recordWindow(...args);
    });

    let syncPid: number | undefined;
    let editPid: number | undefined;
    const sync = getDb().transaction(async (tx) => {
      syncPid = await backendPid(tx);
      await ingest(syncBatch(fixture, [[{ symbol }, '120']]), tx);
    });
    let edit: Promise<unknown> = Promise.resolve();
    let blocked = false;
    try {
      // Raced with the batch, so one that throws fails the test rather than
      // leaving it waiting for a window it never reaches.
      await Promise.race([atWindow.passed, sync]);
      edit = getDb().transaction(async (tx) => {
        editPid = await backendPid(tx);
        await editBalance(fixture, holding.id, '150', tx);
      });
      // Released only once the edit waits on the batch, so the interleaving is
      // the race and not a sequence that happened to be safe.
      blocked = await waitUntilBlocked({ pid: () => editPid, settled: edit }, syncPid!);
    } finally {
      proceed.open();
    }
    const outcomes = await Promise.allSettled([sync, edit]);

    expect({ blocked, outcomes: outcomes.map(outcomeOf) }).toEqual({
      blocked: true,
      outcomes: ['fulfilled', 'fulfilled'],
    });
    // The edit committed second, so its figure is the cache, beside the sync's checkpoint.
    expect({
      balance: await balanceOf(holding.id),
      observed: await observedBalances(holding.id),
    }).toEqual({ balance: '150', observed: ['120', '150'] });
  });

  /**
   * Another transaction holds one of the batch's two holdings, and the batch,
   * which names the higher id first, waits on it. What it already holds at that
   * moment is the order it takes them in.
   */
  async function whileTheBatchWaitsOn(which: 'lower' | 'higher') {
    const fixture = await account(2);
    const [lower, higher] = [...fixture.holdings].sort((a, b) =>
      a.holding.id < b.holding.id ? -1 : 1
    ) as [Fixture['holdings'][number], Fixture['holdings'][number]];
    const [held, other] = which === 'lower' ? [lower, higher] : [higher, lower];
    const holding = latch();
    const release = latch();
    let holderPid: number | undefined;
    let syncPid: number | undefined;

    const holder = getDb().transaction(async (tx) => {
      holderPid = await backendPid(tx);
      await tx
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(eq(schema.holdings.id, held.holding.id))
        .for('no key update');
      holding.open();
      await release.passed;
    });
    let sync: Promise<unknown> = Promise.resolve();
    let reading: { blocked: boolean; otherRow: string; observationLocks: string[] };
    try {
      await Promise.race([holding.passed, holder]);
      sync = getDb().transaction(async (tx) => {
        syncPid = await backendPid(tx);
        await ingest(
          syncBatch(fixture, [
            [higher, '120'],
            [lower, '130'],
          ]),
          tx
        );
      });
      const blocked = await waitUntilBlocked({ pid: () => syncPid, settled: sync }, holderPid!);
      reading = {
        blocked,
        otherRow: (await rowLocked(other.holding.id)) ? 'locked' : 'free',
        observationLocks: await Promise.all(
          [lower, higher].map(async ({ holding: h }) =>
            (await observationLockFree(h.id)) ? 'free' : 'held'
          )
        ),
      };
    } finally {
      release.open();
    }
    const outcomes = await Promise.allSettled([holder, sync]);
    return { ...reading, outcomes: outcomes.map(outcomeOf) };
  }

  test('waiting on the higher id, a batch already holds the lower one and has appended nothing', async () => {
    expect(await whileTheBatchWaitsOn('higher')).toEqual({
      blocked: true,
      otherRow: 'locked',
      observationLocks: ['free', 'free'],
      outcomes: ['fulfilled', 'fulfilled'],
    });
  });

  test('waiting on the lower id, a batch holds neither, though it names the higher one first', async () => {
    expect(await whileTheBatchWaitsOn('lower')).toEqual({
      blocked: true,
      otherRow: 'free',
      observationLocks: ['free', 'free'],
      outcomes: ['fulfilled', 'fulfilled'],
    });
  });

  /**
   * A holding the batch writes a ledger row into is locked FOR UPDATE, the
   * level the ledger upsert takes, and not NO KEY UPDATE first. FOR UPDATE
   * waits on every uncommitted row naming the holding (KEY SHARE), so taking
   * NO KEY UPDATE and then it would be an upgrade: the batch would hold the
   * row while waiting on such a transaction, and that transaction's own
   * balance write would wait on the batch. The other transaction here is a
   * writer that names the holding, then writes it.
   */
  test('an entry batch waits out a transaction that wrote a row naming its holding and then edits it: both commit (no 40P01)', async () => {
    const fixture = await account(1, 'statement-import');
    const [{ holding, symbol }] = fixture.holdings as [Fixture['holdings'][number]];
    const inserted = latch();
    const proceed = latch();
    let rowPid: number | undefined;
    let batchPid: number | undefined;

    const writer = getDb().transaction(async (tx) => {
      rowPid = await backendPid(tx);
      await makeHoldingTransaction(tx, {
        userId: fixture.userId,
        holdingId: holding.id,
        kind: 'deposit',
        quantity: '5',
        occurredAt: CAPTURED,
        source: 'user-entered',
      });
      inserted.open();
      await proceed.passed;
      await editBalance(fixture, holding.id, '200', tx);
    });
    let batch: Promise<unknown> = Promise.resolve();
    let blocked = false;
    try {
      await Promise.race([inserted.passed, writer]);
      batch = getDb().transaction(async (tx) => {
        batchPid = await backendPid(tx);
        await ingest(entryBatch(fixture, [{ symbol }]), tx);
      });
      blocked = await waitUntilBlocked({ pid: () => batchPid, settled: batch }, rowPid!);
    } finally {
      proceed.open();
    }
    const outcomes = await Promise.allSettled([writer, batch]);

    expect({ blocked, outcomes: outcomes.map(outcomeOf) }).toEqual({
      blocked: true,
      outcomes: ['fulfilled', 'fulfilled'],
    });
  });
});
