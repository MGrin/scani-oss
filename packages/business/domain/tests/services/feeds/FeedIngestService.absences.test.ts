/**
 * Absences through `FeedIngestService.ingest` (foundation A2 Task 14, R60–R62):
 * the holdings a feed's silence zeroes, how each zero is written, and the
 * statement tally beside it.
 *
 * A zero is today's: the cache at '0' and one observation at now with the
 * sync's source and origin, now labelled as A1 labels it (R60). Which holdings
 * are candidates is today's scope, less a holding only another input owns
 * (R62). Each zero has its own savepoint, so one that throws costs only itself
 * (R61).
 *
 * Most tests run inside a rolled-back transaction. The last block commits,
 * because labels are read by the classification backfill and history by
 * `BalanceAtTimeService`, both from committed rows.
 */

import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { AbsenceWriter } from '../../../src/services/feeds/AbsenceWriter';
import type { AbsencePolicy } from '../../../src/services/feeds/blocks/absence-confirmer';
import { FeedIngestService } from '../../../src/services/feeds/FeedIngestService';
import type {
  AssetRef,
  FeedBatch,
  FeedCheckpoint,
  LegacyBatchOptions,
} from '../../../src/services/feeds/feed-batch';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { FoundationClassificationService } from '../../../src/services/foundation/FoundationClassificationService';
import { withTestDb } from '../../../test/helpers/db';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';
import { captureHistory } from '../../../test/helpers/history-neutrality';
import { expectLabelsSettled } from '../../../test/helpers/labels-settled';

const ingest = (batch: FeedBatch, tx?: DatabaseTransaction) =>
  Container.get(FeedIngestService).ingest(batch, tx);

const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const T0 = new Date('2026-06-01T00:00:00Z');
const T1 = new Date('2026-06-15T00:00:00Z');
const STATEMENT_AS_OF = new Date('2026-07-20T05:00:00Z');
const CAPTURED = new Date('2026-07-20T05:00:00Z');
const FETCHED = new Date('2026-07-21T09:00:00Z');

const PROVIDER = 'provider:absence-test';
const STATEMENT = 'statement';
const SYNC_TAG = 'sync_exchange_balances';
const IMPORT_TAG = 'import_absence-test';
const ZERO_ORIGIN = { origin: 'updateHoldingBalanceWithEvent' };

const freshSymbol = () => `A${randomUUID().replace(/-/g, '').toUpperCase()}`;

function confirmed(
  over: Partial<Extract<AbsencePolicy, { mode: 'confirmed' }>> = {}
): AbsencePolicy {
  return {
    mode: 'confirmed',
    guardEmptySnapshot: true,
    confirmations: { typeCode: 'fiat', statements: 3 },
    providerRows: 1,
    statementAsOf: STATEMENT_AS_OF,
    ...over,
  };
}

const immediate = (reportedKeys: string[]): AbsencePolicy => ({
  mode: 'immediate',
  guardEmptySnapshot: false,
  confirmations: null,
  reportedKeys,
  statementAsOf: CAPTURED,
});

const asset = (symbol: string): AssetRef => ({
  identity: { symbol, name: symbol },
  typeCode: 'crypto',
  lookup: 'catalog-symbol',
});

const checkpoint = (symbol: string, amount: string): FeedCheckpoint => ({
  asset: asset(symbol),
  at: CAPTURED,
  amount,
  authority: 'provider',
  legacySource: 'sync-capture',
  legacyMeta: ZERO_ORIGIN,
});

function sync(
  owner: { userId: string; accountId: string },
  fields: Partial<Pick<FeedBatch, 'checkpoints' | 'absences'>> &
    Partial<Pick<LegacyBatchOptions, 'absence' | 'clearsAbsenceTally' | 'holdingSource'>>
): FeedBatch {
  return {
    userId: owner.userId,
    input: { accountId: owner.accountId, source: PROVIDER, credentialId: null, walletId: null },
    fetchedAt: FETCHED,
    window: { shape: 'balance-snapshot', from: CAPTURED, to: FETCHED, complete: false },
    checkpoints: fields.checkpoints ?? [],
    entries: [],
    absences: fields.absences ?? [],
    legacy: {
      holdingMatch: 'ingest-order',
      holdingPolicy: 'create',
      holdingSource: fields.holdingSource ?? SYNC_TAG,
      arrival: 'auto_discovered',
      writesCache: true,
      createdWithoutCheckpoint: 'zero',
      derivesTradeLegs: false,
      holdingFailure: 'skip-entry',
      absence: fields.absence ?? null,
      clearsAbsenceTally: fields.clearsAbsenceTally ?? false,
      createdCheckpointMeta: null,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
    },
    notices: [],
  };
}

async function typeIdOf(tx: DatabaseTransaction, code: 'fiat' | 'crypto') {
  const [type] = await tx
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, code));
  if (!type) throw new Error(`no token type ${code}; the seed migration has one`);
  return type.id;
}

async function owner(tx: DatabaseTransaction, institutionTypeId?: string) {
  const userId = (await makeUser(tx)).id;
  const institution = await makeInstitution(
    tx,
    institutionTypeId === undefined ? {} : { typeId: institutionTypeId }
  );
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  return { userId, accountId: account.id, institutionId: institution.id };
}

async function input(
  tx: DatabaseTransaction,
  of: { userId: string; accountId: string },
  source: string
) {
  const [row] = await tx
    .insert(schema.feedInputs)
    .values({ userId: of.userId, accountId: of.accountId, source })
    .returning();
  if (!row) throw new Error('feed_inputs insert failed');
  return row.id;
}

/** A holding with today's unlabelled sync observation, or a statement close, behind it. */
async function holding(
  tx: DatabaseTransaction,
  of: { userId: string; accountId: string },
  fields: {
    tokenId: string;
    balance: string;
    source?: string;
    kind?: 'feed' | 'snapshot';
    externalId?: string | null;
    absentFromStatements?: Date[] | null;
    evidence?: ReadonlyArray<'sync' | 'statement'>;
  }
) {
  const row = await makeHolding(tx, {
    userId: of.userId,
    accountId: of.accountId,
    tokenId: fields.tokenId,
    balance: fields.balance,
    source: fields.source ?? SYNC_TAG,
    ...(fields.kind === undefined ? {} : { kind: fields.kind }),
    externalId: fields.externalId ?? null,
    absentFromStatements: fields.absentFromStatements ?? null,
    createdAt: T0,
    lastUpdated: LONG_AGO,
  });
  for (const kind of fields.evidence ?? ['sync']) {
    await tx.insert(schema.holdingBalanceObservations).values({
      userId: of.userId,
      holdingId: row.id,
      balance: fields.balance,
      observedAt: kind === 'sync' ? T0 : T1,
      source: kind === 'sync' ? 'sync-capture' : 'statement-close',
      sourceMetadata: kind === 'sync' ? ZERO_ORIGIN : { format: 'csv' },
    });
  }
  return row;
}

async function holdingRow(tx: DatabaseTransaction, holdingId: string) {
  const [found] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  if (!found) throw new Error(`holding ${holdingId} is gone`);
  return found;
}

const balances = async (tx: DatabaseTransaction, ids: Record<string, string>) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(ids).map(async ([name, id]) => [name, (await holdingRow(tx, id)).balance])
    )
  );

const observationsOf = (tx: DatabaseTransaction, holdingId: string) =>
  tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
    .orderBy(asc(schema.holdingBalanceObservations.observedAt));

/** Runs `run` with the absence writer's `level` log captured instead of printed. */
async function capturingLog<T>(
  level: 'warn' | 'error',
  run: () => Promise<T>
): Promise<{ result: T; logged: unknown[][] }> {
  const { logger } = Container.get(AbsenceWriter) as unknown as {
    logger: Record<'warn' | 'error', (context: unknown, message: string) => void>;
  };
  const spy = spyOn(logger, level).mockImplementation(() => {});
  try {
    const result = await run();
    return { result, logged: spy.mock.calls.map((call) => [...call]) };
  } finally {
    spy.mockRestore();
  }
}

describe('FeedIngestService.ingest — a confirmed absence (the exchange sync, Z1)', () => {
  test("a zero sets the cache to '0' and writes one labelled observation at statementAsOf, and the tally lands in the same write", async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const providerInput = await input(tx, fixture, PROVIDER);
      const [reported, gone] = [
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
      ];
      const cad = await makeToken(tx, {
        symbol: freshSymbol(),
        typeId: await typeIdOf(tx, 'fiat'),
      });
      const kept = await holding(tx, fixture, { tokenId: reported.id, balance: '10' });
      const zeroed = await holding(tx, fixture, {
        tokenId: gone.id,
        balance: '5',
        source: IMPORT_TAG,
        externalId: 'GONE',
      });
      const tallied = await holding(tx, fixture, { tokenId: cad.id, balance: '47.87' });

      const before = new Date();
      const result = await ingest(
        sync(fixture, {
          checkpoints: [checkpoint(reported.symbol, '11')],
          absence: confirmed(),
        }),
        tx
      );
      const after = new Date();

      expect(result.inputId).toBe(providerInput);
      expect(result.zeroedHoldingIds).toEqual([zeroed.id]);
      expect(await balances(tx, { kept: kept.id, zeroed: zeroed.id, tallied: tallied.id })).toEqual(
        { kept: '11', zeroed: '0', tallied: '47.87' }
      );

      const zeroRow = await holdingRow(tx, zeroed.id);
      expect(zeroRow.lastUpdated >= before && zeroRow.lastUpdated <= after).toBe(true);
      const written = (await observationsOf(tx, zeroed.id)).filter((o) => o.observedAt > T0);
      expect(written).toHaveLength(1);
      const [zero] = written;
      // Dated when the answer was true, not when it was written (A5 D-22, R60).
      expect(zero!.observedAt).toEqual(STATEMENT_AS_OF);
      expect({
        balance: zero!.balance,
        source: zero!.source,
        sourceMetadata: zero!.sourceMetadata,
        role: zero!.role,
        authority: zero!.authority,
        inputId: zero!.inputId,
        cause: zero!.cause,
      }).toEqual({
        balance: '0',
        source: 'sync-capture',
        sourceMetadata: ZERO_ORIGIN,
        role: 'checkpoint',
        authority: 'provider',
        inputId: providerInput,
        cause: null,
      });

      // The fiat holding is missing from its first statement: the day is
      // recorded, and nothing else about it moves.
      const tallyRow = await holdingRow(tx, tallied.id);
      expect(tallyRow.absentFromStatements).toEqual([STATEMENT_AS_OF]);
      expect(tallyRow.lastUpdated).toEqual(LONG_AGO);
      expect(await observationsOf(tx, tallied.id)).toHaveLength(1);
    });
  });

  test('an absence never zeroes a holding another input owns', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      await input(tx, fixture, PROVIDER);
      await input(tx, fixture, STATEMENT);
      const tokens: Array<typeof schema.tokens.$inferSelect> = [];
      for (let i = 0; i < 8; i += 1) tokens.push(await makeToken(tx, { symbol: freshSymbol() }));
      const scamToken = await makeToken(tx, { symbol: freshSymbol(), isScamProbability: 0.99 });
      const [reported, statementOnly, both, unowned, manual, personsFeed, syncSnapshot] = tokens;
      await holding(tx, fixture, { tokenId: reported!.id, balance: '1' });
      const ids = {
        statementOnly: (
          await holding(tx, fixture, {
            tokenId: statementOnly!.id,
            balance: '300',
            source: 'statement-import',
            evidence: ['statement'],
          })
        ).id,
        both: (
          await holding(tx, fixture, {
            tokenId: both!.id,
            balance: '20',
            evidence: ['sync', 'statement'],
          })
        ).id,
        unowned: (await holding(tx, fixture, { tokenId: unowned!.id, balance: '7', evidence: [] }))
          .id,
        manual: (
          await holding(tx, fixture, { tokenId: manual!.id, balance: '9', source: 'manual' })
        ).id,
        // A person's row a feed took over is the sync's to write (A5 D-4), and
        // a snapshot never is, whatever its source.
        personsFeed: (
          await holding(tx, fixture, {
            tokenId: personsFeed!.id,
            balance: '4',
            source: 'manual',
            kind: 'feed',
          })
        ).id,
        syncSnapshot: (
          await holding(tx, fixture, {
            tokenId: syncSnapshot!.id,
            balance: '6',
            kind: 'snapshot',
          })
        ).id,
        scam: (await holding(tx, fixture, { tokenId: scamToken.id, balance: '1000' })).id,
      };

      // Unlabelled rows: ownership is what A1 reads them as, not what is persisted.
      const result = await ingest(
        sync(fixture, {
          checkpoints: [checkpoint(reported!.symbol, '1')],
          absence: confirmed({ confirmations: null }),
        }),
        tx
      );

      // Only a statement has checkpointed `statementOnly`, so it is the
      // statement's; `both` is this input's too; nobody has checkpointed
      // `unowned`, which today's scope zeroes. A person's row and a scam token
      // are outside the sync's scope, as today.
      expect(await balances(tx, ids)).toEqual({
        statementOnly: '300',
        both: '0',
        unowned: '0',
        manual: '9',
        personsFeed: '0',
        syncSnapshot: '6',
        scam: '1000',
      });
      expect([...result.zeroedHoldingIds].sort()).toEqual(
        [ids.both, ids.unowned, ids.personsFeed].sort()
      );
    });
  });

  test('an empty snapshot zeroes nothing, records no tally, and says how many balances it left', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      await input(tx, fixture, PROVIDER);
      const crypto = await makeToken(tx, { symbol: freshSymbol() });
      const cad = await makeToken(tx, {
        symbol: freshSymbol(),
        typeId: await typeIdOf(tx, 'fiat'),
      });
      const ids = {
        held: (await holding(tx, fixture, { tokenId: crypto.id, balance: '12345.67' })).id,
        cash: (await holding(tx, fixture, { tokenId: cad.id, balance: '47.87' })).id,
      };

      const { result, logged } = await capturingLog('warn', () =>
        ingest(sync(fixture, { absence: confirmed({ providerRows: 0 }) }), tx)
      );

      expect(result.zeroedHoldingIds).toEqual([]);
      expect(await balances(tx, ids)).toEqual({ held: '12345.67', cash: '47.87' });
      expect((await holdingRow(tx, ids.cash)).absentFromStatements).toBeNull();
      expect(logged).toEqual([
        [
          {
            accountId: fixture.accountId,
            userId: fixture.userId,
            sourceTag: SYNC_TAG,
            preservedHoldings: 2,
          },
          'Empty snapshot under staleStrategy=zero — refusing to zero holdings; balances left stale',
        ],
      ]);
    });
  });

  test('a reappearing holding clears its tally, on the paths that clear one today', async () => {
    for (const clearsAbsenceTally of [true, false]) {
      await withTestDb(async (tx) => {
        const fixture = await owner(tx);
        await input(tx, fixture, PROVIDER);
        const cad = await makeToken(tx, {
          symbol: freshSymbol(),
          typeId: await typeIdOf(tx, 'fiat'),
        });
        const cash = await holding(tx, fixture, {
          tokenId: cad.id,
          balance: '47.87',
          absentFromStatements: [new Date('2026-07-19T05:00:00Z')],
        });

        await ingest(
          sync(fixture, {
            checkpoints: [checkpoint(cad.symbol, '47.87')],
            absence: clearsAbsenceTally ? confirmed() : null,
            clearsAbsenceTally,
          }),
          tx
        );

        // The syncs and refresh clear it; an import never did.
        expect((await holdingRow(tx, cash.id)).absentFromStatements).toEqual(
          clearsAbsenceTally ? null : [new Date('2026-07-19T05:00:00Z')]
        );
      });
    }
  });

  test('a zero that throws on one holding leaves the others zeroed, and is logged', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      await input(tx, fixture, PROVIDER);
      const tokens: Array<typeof schema.tokens.$inferSelect> = [];
      for (let i = 0; i < 3; i += 1) tokens.push(await makeToken(tx, { symbol: freshSymbol() }));
      const ids = {
        first: (await holding(tx, fixture, { tokenId: tokens[0]!.id, balance: '1' })).id,
        failing: (await holding(tx, fixture, { tokenId: tokens[1]!.id, balance: '2' })).id,
        last: (await holding(tx, fixture, { tokenId: tokens[2]!.id, balance: '3' })).id,
      };
      const writer = Container.get(HoldingCacheWriter);
      const apply = writer.apply.bind(writer);
      // A database error, not a thrown value: without its own savepoint it
      // would abort the batch's whole transaction (25P02).
      const broken = spyOn(writer, 'apply').mockImplementation(async (userId, writes, within) => {
        if (writes.some((w) => w.holdingId === ids.failing)) {
          await within.execute(sql`select 1 / 0`);
        }
        return await apply(userId, writes, within);
      });

      try {
        const { result, logged } = await capturingLog('error', () =>
          ingest(sync(fixture, { absence: confirmed({ confirmations: null }) }), tx)
        );

        expect(await balances(tx, ids)).toEqual({ first: '0', failing: '2', last: '0' });
        expect([...result.zeroedHoldingIds].sort()).toEqual([ids.first, ids.last].sort());
        expect(await observationsOf(tx, ids.failing)).toHaveLength(1);
        expect(logged).toHaveLength(1);
        const [context, message] = logged[0] as [{ holdingId: string; error: string }, string];
        expect(message).toBe('Failed to zero out stale holding');
        expect(context.holdingId).toBe(ids.failing);
        expect(context.error).toContain('select 1 / 0');
      } finally {
        broken.mockRestore();
      }
    });
  });
});

describe('FeedIngestService.ingest — an immediate absence (an integration import, Z2)', () => {
  test('immediate zeroes on the first absence: only the rows its importer tagged, by the keys it reported', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      await input(tx, fixture, PROVIDER);
      const tokens: Array<typeof schema.tokens.$inferSelect> = [];
      for (let i = 0; i < 5; i += 1) tokens.push(await makeToken(tx, { symbol: freshSymbol() }));
      const usd = await makeToken(tx, {
        symbol: freshSymbol(),
        typeId: await typeIdOf(tx, 'fiat'),
      });
      const tagged = (i: number, externalId: string | null, balance: string) =>
        holding(tx, fixture, { tokenId: tokens[i]!.id, balance, source: IMPORT_TAG, externalId });
      const ids = {
        reported: (await tagged(0, 'KEEP', '4')).id,
        // An asset the import names but skips, such as one reported at zero,
        // is still reported: its old balance stays, as today.
        skipped: (await tagged(1, 'SKIPPED', '3')).id,
        gone: (await tagged(2, 'GONE', '5')).id,
        unkeyed: (await tagged(3, null, '6')).id,
        otherTag: (await holding(tx, fixture, { tokenId: tokens[4]!.id, balance: '8' })).id,
        fiat: (
          await holding(tx, fixture, {
            tokenId: usd.id,
            balance: '100',
            source: IMPORT_TAG,
            externalId: 'USD',
            absentFromStatements: [new Date('2026-07-19T05:00:00Z')],
          })
        ).id,
      };

      await ingest(
        sync(fixture, {
          holdingSource: IMPORT_TAG,
          absence: immediate(['KEEP', 'SKIPPED']),
        }),
        tx
      );

      expect(await balances(tx, ids)).toEqual({
        reported: '4',
        skipped: '3',
        gone: '0',
        unkeyed: '0',
        otherTag: '8',
        fiat: '0',
      });
      // No tally on an import: the fiat zeroes at once and its dates stay.
      expect((await holdingRow(tx, ids.fiat)).absentFromStatements).toEqual([
        new Date('2026-07-19T05:00:00Z'),
      ]);
    });
  });
});

describe('FeedIngestService.ingest — explicit absences (probe exits, Z3)', () => {
  test('an explicit absence zeroes its holding at its own instant, never creates one, and bypasses the guard', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const providerInput = await input(tx, fixture, PROVIDER);
      const [exited, future, unheld] = [
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
      ];
      const ids = {
        exited: (
          await holding(tx, fixture, {
            tokenId: exited.id,
            balance: '5',
            absentFromStatements: [new Date('2026-07-19T05:00:00Z')],
          })
        ).id,
        future: (await holding(tx, fixture, { tokenId: future.id, balance: '6' })).id,
      };
      const inTheFuture = new Date(Date.now() + 86_400_000);

      const before = new Date();
      const result = await ingest(
        sync(fixture, {
          absence: confirmed({ providerRows: 0 }),
          clearsAbsenceTally: true,
          absences: [
            { asset: asset(exited.symbol), confirmedAt: CAPTURED },
            { asset: asset(future.symbol), confirmedAt: inTheFuture },
            { asset: asset(unheld.symbol), confirmedAt: CAPTURED },
          ],
        }),
        tx
      );
      const after = new Date();

      expect(await balances(tx, ids)).toEqual({ exited: '0', future: '0' });
      expect([...result.zeroedHoldingIds].sort()).toEqual([ids.exited, ids.future].sort());
      const [, exitZero] = await observationsOf(tx, ids.exited);
      expect({
        observedAt: exitZero!.observedAt,
        balance: exitZero!.balance,
        source: exitZero!.source,
        sourceMetadata: exitZero!.sourceMetadata,
        role: exitZero!.role,
        authority: exitZero!.authority,
        inputId: exitZero!.inputId,
      }).toEqual({
        observedAt: CAPTURED,
        balance: '0',
        source: 'sync-capture',
        sourceMetadata: ZERO_ORIGIN,
        role: 'checkpoint',
        authority: 'provider',
        inputId: providerInput,
      });
      // A future instant is a clock error and becomes now, as today.
      const [, futureZero] = await observationsOf(tx, ids.future);
      expect(futureZero!.observedAt >= before && futureZero!.observedAt <= after).toBe(true);
      expect((await holdingRow(tx, ids.exited)).absentFromStatements).toBeNull();
      const unheldRows = await tx
        .select()
        .from(schema.holdings)
        .where(
          and(
            eq(schema.holdings.accountId, fixture.accountId),
            eq(schema.holdings.tokenId, unheld.id)
          )
        );
      expect(unheldRows).toEqual([]);
    });
  });
});

describe('FeedIngestService.ingest — absences, committed', () => {
  const createdUserIds: string[] = [];
  const createdTokenIds: string[] = [];
  const createdInstitutionIds: string[] = [];
  const restores: Array<{ mockRestore: () => void }> = [];

  afterEach(async () => {
    for (const spy of restores.splice(0)) spy.mockRestore();
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

  const read = <T>(fn: (tx: DatabaseTransaction) => Promise<T>) => getDb().transaction(fn);

  /** An account with the provider input, a reported holding, one to zero and a fiat one to tally, backfilled. */
  async function seed() {
    const seeded = await getDb().transaction(async (tx) => {
      const bank = await makeInstitutionType(tx, { code: 'bank' });
      const fixture = await owner(tx, bank.id);
      createdUserIds.push(fixture.userId);
      createdInstitutionIds.push(fixture.institutionId);
      await input(tx, fixture, PROVIDER);
      const reported = await makeToken(tx, { symbol: freshSymbol() });
      const gone = await makeToken(tx, { symbol: freshSymbol() });
      const cad = await makeToken(tx, {
        symbol: freshSymbol(),
        typeId: await typeIdOf(tx, 'fiat'),
      });
      createdTokenIds.push(reported.id, gone.id, cad.id);
      return {
        fixture,
        reported,
        gone,
        kept: await holding(tx, fixture, { tokenId: reported.id, balance: '10' }),
        zeroed: await holding(tx, fixture, { tokenId: gone.id, balance: '5' }),
        tallied: await holding(tx, fixture, { tokenId: cad.id, balance: '47.87' }),
      };
    });
    await Container.get(FoundationClassificationService).classify({
      apply: true,
      userId: seeded.fixture.userId,
    });
    return seeded;
  }

  const batchOf = (seeded: Awaited<ReturnType<typeof seed>>) =>
    sync(seeded.fixture, {
      checkpoints: [checkpoint(seeded.reported.symbol, '11')],
      absence: confirmed(),
      clearsAbsenceTally: true,
    });

  test("R60: exactly one observation per zero, at statementAsOf, with today's source and origin, and the labels settle", async () => {
    const seeded = await seed();

    const first = await ingest(batchOf(seeded));

    const zeros = await read((tx) => observationsOf(tx, seeded.zeroed.id));
    expect(zeros.map((o) => o.balance)).toEqual(['5', '0']);
    const zero = zeros[1]!;
    expect(zero.observedAt).toEqual(STATEMENT_AS_OF);
    expect([zero.source, zero.sourceMetadata, zero.role, zero.authority, zero.inputId]).toEqual([
      'sync-capture',
      ZERO_ORIGIN,
      'checkpoint',
      'provider',
      first.inputId,
    ]);
    await expectLabelsSettled(seeded.fixture.userId);

    // The same answer again: the zeroed holding is at '0' and is left alone,
    // and the statement day is already recorded.
    const second = await ingest(batchOf(seeded));
    expect(second.zeroedHoldingIds).toEqual([]);
    expect(await read((tx) => observationsOf(tx, seeded.zeroed.id))).toHaveLength(2);
    expect((await read((tx) => holdingRow(tx, seeded.tallied.id))).absentFromStatements).toEqual([
      STATEMENT_AS_OF,
    ]);
    await expectLabelsSettled(seeded.fixture.userId);
  });

  // The old path's zero was `HoldingService.updateHoldingBalanceWithEvent` with
  // no `observedAt`, deleted once nothing called it: the balance set, then one
  // `sync-capture` observation of it at now under that method's origin. A twin
  // holding, with the same history, is zeroed each way. The two zeros match in
  // every column but the date: since A5 D-22 (R60) the new one sits at the
  // answer's `statementAsOf`, so history reads 0 from there and not from the
  // write. The clock is held still so only that may differ.
  test("the zero matches the old path's in every column but its date, which R60 moves to statementAsOf", async () => {
    const seeded = await seed();
    const twin = await getDb().transaction(async (tx) => {
      const account = await makeAccount(tx, {
        userId: seeded.fixture.userId,
        institutionId: seeded.fixture.institutionId,
      });
      return await holding(
        tx,
        { userId: seeded.fixture.userId, accountId: account.id },
        { tokenId: seeded.gone.id, balance: '5' }
      );
    });

    const zeroAt = new Date('2026-08-01T12:00:00Z');
    setSystemTime(zeroAt);
    try {
      await seedHoldingCache(getDb(), (calculator) =>
        calculator
          .update(schema.holdings)
          .set({ balance: '0', lastUpdated: new Date() })
          .where(eq(schema.holdings.id, twin.id))
      );
      await Container.get(HoldingBalanceObservationRepository).append({
        userId: seeded.fixture.userId,
        holdingId: twin.id,
        balance: '0',
        observedAt: new Date(),
        source: 'sync-capture',
        sourceMetadata: ZERO_ORIGIN,
      });
      await ingest(batchOf(seeded));
    } finally {
      setSystemTime();
    }

    const instants = [
      new Date(T0.getTime() - 86_400_000),
      T0,
      new Date(T0.getTime() + 86_400_000),
      new Date(zeroAt.getTime() - 1),
      zeroAt,
      new Date(Date.now() + 1_000),
    ];
    const strip = (readings: Awaited<ReturnType<typeof captureHistory>>) =>
      readings.map(({ at, balance, anchor }) => ({ at, balance, anchor }));
    const old = strip(await captureHistory([twin.id], instants));
    const moved = strip(await captureHistory([seeded.zeroed.id], instants));
    // Since A5 PR-2 the engine reads both (D-10): absent before the holding's
    // start, then the 5 walked forward until the zero. The old walk spread
    // the unexplained drop across the days before it.
    expect(old.map((r) => r.balance)).toEqual([null, '5', '5', '5', '0', '0']);
    // The new zero sits at statementAsOf, before the write's instant.
    expect(moved.map((r) => r.balance)).toEqual([null, '5', '5', '0', '0', '0']);

    const [oldZero, newZero] = await read(async (tx) => [
      (await observationsOf(tx, twin.id))[1]!,
      (await observationsOf(tx, seeded.zeroed.id))[1]!,
    ]);
    const columns = (o: typeof oldZero) => ({
      observedAt: o!.observedAt,
      balance: o!.balance,
      source: o!.source,
      sourceMetadata: o!.sourceMetadata,
      gapReview: o!.gapReview,
      supersededAt: o!.supersededAt,
    });
    expect({ ...columns(newZero), observedAt: oldZero!.observedAt }).toEqual(columns(oldZero));
    expect(newZero!.observedAt).toEqual(STATEMENT_AS_OF);
    const cache = await read(async (tx) => ({
      old: (await holdingRow(tx, twin.id)).balance,
      moved: (await holdingRow(tx, seeded.zeroed.id)).balance,
    }));
    expect(cache).toEqual({ old: '0', moved: '0' });
  });

  test('a failure later in the batch rolls back its zeros and its tally with everything else', async () => {
    const seeded = await seed();
    const duringFailure: Array<{ zeroed: string; tally: Date[] | null }> = [];
    const failing = spyOn(Container.get(HoldingRepository), 'markFeed').mockImplementation(
      async (_userId, _ids, tx) => {
        duringFailure.push({
          zeroed: (await holdingRow(tx, seeded.zeroed.id)).balance,
          tally: (await holdingRow(tx, seeded.tallied.id)).absentFromStatements,
        });
        throw new Error('kind flip failed');
      }
    );
    restores.push(failing);

    await expect(ingest(batchOf(seeded))).rejects.toThrow('kind flip failed');

    expect(duringFailure).toEqual([{ zeroed: '0', tally: [STATEMENT_AS_OF] }]);
    await read(async (tx) => {
      expect((await holdingRow(tx, seeded.zeroed.id)).balance).toBe('5');
      expect((await holdingRow(tx, seeded.tallied.id)).absentFromStatements).toBeNull();
      expect(await observationsOf(tx, seeded.zeroed.id)).toHaveLength(1);
    });
  });
});
