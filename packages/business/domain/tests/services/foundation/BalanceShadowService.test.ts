import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { BalanceShadowService } from '../../../src/services/foundation/BalanceShadowService';
import { classifyHoldingEvidence } from '../../../src/services/foundation/legacy-classification';
import {
  compareBalance,
  type LegacyBalanceReading,
} from '../../../src/services/foundation/shadow-comparison';
import { BalanceAtTimeService } from '../../../src/services/pricing/BalanceAtTimeService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';
import {
  captureRunIds,
  differencesOf,
  evidenceFingerprint,
  failingShadowUsers,
  onlyUsers,
  runRow,
} from '../../../test/helpers/shadow-runs';

restoreContainerAfterAll();

const service = () => Container.get(BalanceShadowService);
const at = (iso: string) => new Date(iso);
const AS_OF = at('2026-03-01T00:00:00Z');
// Explicit, or `starts_at` would be the real clock's today, after AS_OF.
const CREATED = at('2026-01-01T00:00:00Z');

type HoldingRow = typeof schema.holdings.$inferSelect;

async function holdingOf(
  tx: DatabaseTransaction,
  userId: string,
  fields: { balance: string; source: string }
): Promise<HoldingRow> {
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  const token = await makeToken(tx);
  return makeHolding(tx, {
    userId,
    accountId: account.id,
    tokenId: token.id,
    createdAt: CREATED,
    ...fields,
  });
}

async function observe(
  tx: DatabaseTransaction,
  holding: HoldingRow,
  observedAt: Date,
  balance: string,
  origin: string
): Promise<void> {
  await tx.insert(schema.holdingBalanceObservations).values({
    userId: holding.userId,
    holdingId: holding.id,
    balance,
    observedAt,
    source: 'sync-capture',
    sourceMetadata: { origin },
  });
}

/** A manual holding the person set to 50 on Feb 1, stored as 50. */
async function matchingManual(tx: DatabaseTransaction, userId: string): Promise<HoldingRow> {
  const holding = await holdingOf(tx, userId, { balance: '50', source: 'manual' });
  await observe(tx, holding, at('2026-02-01T00:00:00Z'), '50', 'updateHolding');
  return holding;
}

/** A synced wallet holding: the provider said 100 on Feb 27, then a +5 deposit on Feb 28. */
async function walletAheadOfAnchor(tx: DatabaseTransaction, userId: string): Promise<HoldingRow> {
  const holding = await holdingOf(tx, userId, { balance: '100', source: 'blockchain' });
  await observe(tx, holding, at('2026-02-27T00:00:00Z'), '100', 'updateHoldingBalanceWithEvent');
  await makeHoldingTransaction(tx, {
    userId,
    holdingId: holding.id,
    tokenId: holding.tokenId,
    kind: 'deposit',
    quantity: '5',
    source: 'etherscan',
    occurredAt: at('2026-02-28T00:00:00Z'),
  });
  return holding;
}

/**
 * A manual holding typed as 50 on Jan 15 and 80 on Feb 15, with nothing in
 * between. On Feb 1 the engine holds 50; `BalanceAtTimeService` draws a line
 * between the two and answers about 66.
 */
async function interpolatedManual(
  tx: DatabaseTransaction,
  userId: string,
  [first, second] = ['50', '80']
): Promise<HoldingRow> {
  const holding = await holdingOf(tx, userId, { balance: second, source: 'manual' });
  await observe(tx, holding, at('2026-01-15T00:00:00Z'), first, 'updateHolding');
  await observe(tx, holding, at('2026-02-15T00:00:00Z'), second, 'updateHolding');
  return holding;
}

/**
 * A synced wallet holding stored as 15: a +10 deposit on Jan 10, and a legacy
 * +5 opening row the engine excludes, so it derives 10 at every instant.
 */
async function walletWithOpening(tx: DatabaseTransaction, userId: string): Promise<HoldingRow> {
  const holding = await holdingOf(tx, userId, { balance: '15', source: 'blockchain' });
  const row = { userId, holdingId: holding.id, tokenId: holding.tokenId };
  await makeHoldingTransaction(tx, {
    ...row,
    kind: 'deposit',
    quantity: '10',
    source: 'etherscan',
    occurredAt: at('2026-01-10T00:00:00Z'),
  });
  await makeHoldingTransaction(tx, {
    ...row,
    kind: 'opening_balance',
    quantity: '5',
    source: 'reconciliation-opening',
    occurredAt: at('2026-01-05T00:00:00Z'),
  });
  return holding;
}

/** As `findOrCreateForIngest` leaves it: balance 0 and no evidence at all. */
function emptyIngest(tx: DatabaseTransaction, userId: string): Promise<HoldingRow> {
  return holdingOf(tx, userId, { balance: '0', source: 'ingest-backfill' });
}

/**
 * The differences the shadow found when it read each user's evidence in one
 * load, with `BalanceAtTimeService` answering from every holding's rows at
 * once: the result reading one holding at a time must equal.
 */
async function perUserDifferences(
  tx: DatabaseTransaction,
  userId: string,
  asOf: Date,
  pastInstants: readonly Date[]
) {
  const raws = await Container.get(EngineEvidenceRepository).findHoldingEvidence({ userId }, tx);
  const caches = {
    holdings: new Map(raws.map((r) => [r.holding.id, r.holding])),
    observations: new Map(raws.map((r) => [r.holding.id, r.observations])),
    transactions: new Map(raws.map((r) => [r.holding.id, r.transactions])),
  };
  const found = [];
  for (const raw of raws) {
    const holding = classifyHoldingEvidence(raw);
    const readings: Array<{ at: Date; legacy: LegacyBalanceReading }> = [
      {
        at: asOf,
        legacy: {
          comparator: 'stored-balance',
          balance: raw.holding.balance,
          absent: false,
          interpolated: false,
          floored: false,
          lastUpdated: raw.holding.lastUpdated,
        },
      },
    ];
    for (const past of pastInstants) {
      const r = await Container.get(BalanceAtTimeService).getBalance(
        raw.holding.id,
        past,
        tx,
        caches
      );
      readings.push({
        at: past,
        legacy: {
          comparator: 'balance-at-time',
          balance: r.balance?.toFixed() ?? null,
          absent: r.balance === null || r.beforeRecords,
          interpolated: r.interpolated,
          floored: r.floored,
          lastUpdated: null,
        },
      });
    }
    for (const { at: instant, legacy } of readings) {
      const difference = compareBalance(holding, instant, legacy);
      if (difference !== null) found.push({ ...difference, holdingId: raw.holding.id });
    }
  }
  return found;
}

describe('BalanceShadowService.run', () => {
  test('a matching holding is counted and not reported', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await matchingManual(tx, user.id);

      const { runId, summary } = await service().run(
        { asOf: AS_OF, pastInstants: [], userId: user.id },
        tx
      );

      expect(summary.compared).toBe(1);
      expect(summary.matched).toBe(1);
      expect(summary.byCategory).toEqual({});
      expect(await differencesOf(tx, runId)).toEqual([]);
    });
  });

  test('a ledger row after the last checkpoint is reported as ledger-ahead-of-anchor', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const holding = await walletAheadOfAnchor(tx, user.id);

      const { runId, summary } = await service().run(
        { asOf: AS_OF, pastInstants: [], userId: user.id },
        tx
      );

      const rows = await differencesOf(tx, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: user.id,
        holdingId: holding.id,
        tokenId: holding.tokenId,
        baseTokenId: null,
        at: AS_OF,
        comparator: 'stored-balance',
        category: 'ledger-ahead-of-anchor',
        engineValue: '105',
        legacyValue: '100',
      });
      expect(summary).toMatchObject({
        compared: 1,
        matched: 0,
        byCategory: { 'ledger-ahead-of-anchor': 1 },
      });
    });
  });

  test('past instants compare with BalanceAtTimeService', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await interpolatedManual(tx, user.id);
      const feb1 = at('2026-02-01T00:00:00Z');

      const { runId, summary } = await service().run(
        { asOf: AS_OF, pastInstants: [feb1], userId: user.id },
        tx
      );

      const rows = await differencesOf(tx, runId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.comparator === 'balance-at-time')).toBe(true);
      expect(rows.every((r) => r.at.getTime() === feb1.getTime())).toBe(true);
      expect(rows[0]).toMatchObject({ category: 'driftAhead-interpolation', engineValue: '50' });
      expect(summary).toMatchObject({ compared: 2, matched: 1 });
    });
  });

  test('REVIEW FOCUS 4: a run writes only its report', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await matchingManual(tx, user.id);
      await walletAheadOfAnchor(tx, user.id);
      await interpolatedManual(tx, user.id);
      await emptyIngest(tx, user.id);
      const before = await evidenceFingerprint(tx);

      const { runId } = await service().run(
        { asOf: AS_OF, pastInstants: [at('2026-02-01T00:00:00Z')] },
        tx
      );

      expect(await evidenceFingerprint(tx)).toEqual(before);
      expect(before.guard).toBe('D');
      // Not vacuous: the run did compare, and stored what it found.
      expect((await differencesOf(tx, runId)).length).toBeGreaterThanOrEqual(2);
    });
  });

  test('REVIEW FOCUS 5: an empty holding matches', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await emptyIngest(tx, user.id);

      const { runId, summary } = await service().run(
        { asOf: AS_OF, pastInstants: [], userId: user.id },
        tx
      );

      expect(summary).toMatchObject({ compared: 1, matched: 1, byCategory: {} });
      expect(await differencesOf(tx, runId)).toEqual([]);
    });
  });

  test('unlabelled rows are counted', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await matchingManual(tx, user.id);
      await walletAheadOfAnchor(tx, user.id);

      const { summary } = await service().run(
        { asOf: AS_OF, pastInstants: [], userId: user.id },
        tx
      );

      expect(summary.unlabelled).toEqual({ holdings: 2, observations: 2, entries: 1 });
      expect(summary.excluded).toEqual({
        'fabricated-observation': 0,
        'opening-row': 0,
        'legacy-correction-row': 0,
      });
      expect(summary.staleLabels).toBe(0);
    });
  });

  test('a source label its row has moved away from is counted as stale', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const holding = await walletAheadOfAnchor(tx, user.id);
      // Labelled as the backfill would have, before the transfer linker paired it.
      await tx
        .update(schema.holdingTransactions)
        .set({ ledgerKind: 'inflow', kindOrigin: 'source' })
        .where(eq(schema.holdingTransactions.holdingId, holding.id));
      const fresh = await service().run({ asOf: AS_OF, pastInstants: [], userId: user.id }, tx);
      await tx
        .update(schema.holdingTransactions)
        .set({ transferGroupId: randomUUID() })
        .where(eq(schema.holdingTransactions.holdingId, holding.id));

      const { summary } = await service().run(
        { asOf: AS_OF, pastInstants: [], userId: user.id },
        tx
      );

      expect(fresh.summary.staleLabels).toBe(0);
      expect(summary.staleLabels).toBe(1);
    });
  });

  test('a run over several users and instants sums every holding of every user', async () => {
    await withTestDb(async (tx) => {
      const first = await makeUser(tx);
      const second = await makeUser(tx);
      await matchingManual(tx, first.id);
      await walletAheadOfAnchor(tx, first.id);
      await interpolatedManual(tx, second.id);
      await walletWithOpening(tx, second.id);
      const users = onlyUsers([first, second]);

      let result: Awaited<ReturnType<BalanceShadowService['run']>>;
      try {
        result = await service().run(
          { asOf: AS_OF, pastInstants: [at('2026-02-01T00:00:00Z'), at('2026-02-20T00:00:00Z')] },
          tx
        );
      } finally {
        users.mockRestore();
      }

      // 4 holdings x (asOf + 2 past instants). The wallet ahead of its anchor
      // differs at asOf only, the interpolated holding on Feb 1 only, and the
      // wallet with an opening row at all three.
      expect(result.summary).toMatchObject({
        compared: 12,
        matched: 7,
        byCategory: {
          'ledger-ahead-of-anchor': 1,
          'driftAhead-interpolation': 1,
          'opening-row': 3,
        },
        unlabelled: { holdings: 4, observations: 4, entries: 2 },
        excluded: { 'fabricated-observation': 0, 'opening-row': 1, 'legacy-correction-row': 0 },
      });
      const rows = await differencesOf(tx, result.runId);
      expect(rows).toHaveLength(5);
      expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([first.id, second.id]));
    });
  });

  test("each holding's evidence is read on its own, and the run finds what one read per user finds", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const holdings = [
        await matchingManual(tx, user.id),
        await walletAheadOfAnchor(tx, user.id),
        await interpolatedManual(tx, user.id),
        await walletWithOpening(tx, user.id),
      ];
      const pastInstants = [at('2026-02-01T00:00:00Z'), at('2026-02-20T00:00:00Z')];
      const repo = Container.get(EngineEvidenceRepository);
      const load = repo.findHoldingEvidence.bind(repo);
      const scopes: Array<readonly string[] | undefined> = [];
      const evidence = spyOn(repo, 'findHoldingEvidence').mockImplementation(async (scope, t) => {
        scopes.push(scope.holdingIds);
        return load(scope, t);
      });

      let runId: string;
      try {
        ({ runId } = await service().run({ asOf: AS_OF, pastInstants, userId: user.id }, tx));
      } finally {
        evidence.mockRestore();
      }

      expect(scopes.map((ids) => ids?.length)).toEqual([1, 1, 1, 1]);
      expect(scopes.flatMap((ids) => ids ?? []).toSorted()).toEqual(
        holdings.map((h) => h.id).toSorted()
      );
      const key = (d: { holdingId: string | null; at: Date; comparator: string }) =>
        `${d.holdingId} ${d.at.toISOString()} ${d.comparator}`;
      const fields = (d: {
        holdingId: string | null;
        at: Date;
        comparator: string;
        category: string;
        engineValue: string | null;
        legacyValue: string | null;
        detail: unknown;
      }) => ({
        holdingId: d.holdingId,
        at: d.at,
        comparator: d.comparator,
        category: d.category,
        engineValue: d.engineValue,
        legacyValue: d.legacyValue,
        detail: d.detail,
      });
      const expected = (await perUserDifferences(tx, user.id, AS_OF, pastInstants))
        .map(fields)
        .toSorted((a, b) => key(a).localeCompare(key(b)));
      const stored = (await differencesOf(tx, runId))
        .map(fields)
        .toSorted((a, b) => key(a).localeCompare(key(b)));
      // Not vacuous: three of the four holdings differ, in three categories.
      expect(new Set(expected.map((d) => d.category)).size).toBe(3);
      expect(stored).toEqual(expected);
    });
  });

  test('a dust balance is written in plain notation on both sides', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await interpolatedManual(tx, user.id, ['0.00000005', '0.00000008']);

      const { runId } = await service().run(
        { asOf: AS_OF, pastInstants: [at('2026-02-01T00:00:00Z')], userId: user.id },
        tx
      );

      const rows = await differencesOf(tx, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.engineValue).toBe('0.00000005');
      expect(rows[0]?.legacyValue).toMatch(/^0\.0000000664516/);
    });
  });

  test('a run says whether it covered one user or all, and is timed on the wall clock', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await matchingManual(tx, user.id);
      const wallBefore = Date.now();

      const narrowed = await service().run({ asOf: AS_OF, pastInstants: [], userId: user.id }, tx);
      const full = await service().run({ asOf: AS_OF, pastInstants: [] }, tx);

      const one = await runRow(tx, narrowed.runId);
      const all = await runRow(tx, full.runId);
      expect(one).toMatchObject({
        kind: 'balance',
        scope: 'user',
        status: 'complete',
        error: null,
      });
      expect(all).toMatchObject({ kind: 'balance', scope: 'all', status: 'complete', error: null });
      for (const run of [one, all]) {
        expect(run.asOf.getTime()).toBe(AS_OF.getTime());
        expect(run.startedAt.getTime()).toBeGreaterThanOrEqual(wallBefore);
        expect(run.finishedAt.getTime()).toBeGreaterThanOrEqual(run.startedAt.getTime());
        expect(run.summary.durationMs).toBe(run.finishedAt.getTime() - run.startedAt.getTime());
      }
    });
  });

  test('a user that throws inside a caller transaction fails the run, which is recorded, and the error propagates', async () => {
    await withTestDb(async (tx) => {
      const first = await makeUser(tx);
      const second = await makeUser(tx);
      await matchingManual(tx, first.id);
      await matchingManual(tx, second.id);
      const repo = Container.get(EngineEvidenceRepository);
      const load = repo.findHoldingEvidence.bind(repo);
      const users = onlyUsers([first, second]);
      // A database error, so it aborts whatever transaction it runs in: the
      // failed run can only be stored outside the user's savepoint.
      const evidence = spyOn(repo, 'findHoldingEvidence').mockImplementation(async (scope, t) => {
        if (scope.userId === second.id) await t?.execute(sql`SELECT 1/0`);
        return load(scope, t);
      });
      const recorded = captureRunIds();

      let thrown: unknown;
      try {
        await service().run({ asOf: AS_OF, pastInstants: [] }, tx);
      } catch (err) {
        thrown = err;
      } finally {
        users.mockRestore();
        evidence.mockRestore();
        recorded.restore();
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(recorded.ids).toHaveLength(1);
      const run = await runRow(tx, recorded.ids[0] ?? '');
      expect(run.status).toBe('failed');
      expect(run.scope).toBe('all');
      expect(run.error).toContain(second.id);
      expect(run.error).toContain('division by zero');
      // The first user finished before the second failed, and is in the report.
      expect(run.summary).toMatchObject({ compared: 1, matched: 1 });
    });
  });

  test('a setup that throws fails the run, which is recorded, and the error propagates', async () => {
    await withTestDb(async (tx) => {
      const users = failingShadowUsers();
      const recorded = captureRunIds();

      let thrown: unknown;
      try {
        await service().run({ asOf: AS_OF, pastInstants: [] }, tx);
      } catch (err) {
        thrown = err;
      } finally {
        users.mockRestore();
        recorded.restore();
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(recorded.ids).toHaveLength(1);
      const run = await runRow(tx, recorded.ids[0] ?? '');
      expect(run).toMatchObject({ kind: 'balance', scope: 'all', status: 'failed' });
      expect(run.error).toMatch(/^setup: .*division by zero/);
      expect(run.summary).toMatchObject({ compared: 0, matched: 0, byCategory: {} });
    });
  });

  test('without a caller transaction each user reads one read-only snapshot, and a failure is still recorded', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const modes: string[] = [];
    const users = onlyUsers([
      { id: first, baseCurrencyId: null },
      { id: second, baseCurrencyId: null },
    ]);
    // Each user's first read inside its snapshot: the holdings its evidence is then read for.
    const evidence = spyOn(
      Container.get(EngineEvidenceRepository),
      'findHoldingIds'
    ).mockImplementation(async (userId, t) => {
      if (!t) throw new Error('evidence read outside a transaction');
      const [mode] = (await t.execute(
        sql`SELECT current_setting('transaction_isolation') || ' ' || current_setting('transaction_read_only') AS mode`
      )) as unknown as Array<{ mode: string }>;
      modes.push(mode?.mode ?? '');
      if (userId === second) await t.execute(sql`SELECT 1/0`);
      return [];
    });
    const recorded = captureRunIds();
    const runs = schema.engineShadowRuns;

    let thrown: unknown;
    let stored: Array<typeof runs.$inferSelect> = [];
    try {
      try {
        await service().run({ asOf: AS_OF, pastInstants: [] });
      } catch (err) {
        thrown = err;
      }
      if (recorded.ids.length > 0) {
        stored = await getDb().select().from(runs).where(inArray(runs.id, recorded.ids));
      }
    } finally {
      users.mockRestore();
      evidence.mockRestore();
      recorded.restore();
      // Committed by the run itself, so removed by id whatever it turned out to be.
      if (recorded.ids.length > 0) {
        await getDb().delete(runs).where(inArray(runs.id, recorded.ids));
      }
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(modes).toEqual(['repeatable read on', 'repeatable read on']);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('failed');
    expect(stored[0]?.error).toContain('division by zero');
  });
});
