import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { asc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  EngineShadowReportRepository,
  type RecordShadowRunInput,
  SHADOW_RUNS_KEPT,
} from '../../src/repositories/EngineShadowReportRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(EngineShadowReportRepository);

type Difference = RecordShadowRunInput['differences'][number];

const MINUTE = 60_000;
// Every run here starts far past any real one, so a database that already
// holds committed runs cannot push these out of the newest 30.
const FUTURE = Date.parse('2100-01-01T00:00:00Z');

function runInput(fields: Partial<RecordShadowRunInput> = {}): RecordShadowRunInput {
  const startedAt = fields.startedAt ?? new Date(FUTURE);
  return {
    kind: 'balance',
    scope: 'all',
    asOf: startedAt,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + MINUTE),
    status: 'complete',
    summary: { compared: 0, matched: 0, byCategory: {}, durationMs: 0 },
    differences: [],
    ...fields,
  };
}

function difference(fields: Partial<Difference> = {}): Difference {
  return {
    comparator: 'stored-balance',
    category: 'unexplained',
    at: new Date('2026-03-01T00:00:00Z'),
    engineValue: '1',
    legacyValue: '2',
    detail: {},
    userId: null,
    holdingId: null,
    tokenId: null,
    baseTokenId: null,
    ...fields,
  };
}

async function seedHolding(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  const base = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
  });
  return { userId: user.id, holdingId: holding.id, tokenId: token.id, baseTokenId: base.id };
}

const differencesOf = (tx: DatabaseTransaction, runId: string) =>
  tx
    .select()
    .from(schema.engineShadowDifferences)
    .where(eq(schema.engineShadowDifferences.runId, runId))
    .orderBy(asc(schema.engineShadowDifferences.at));

describe('recordRun', () => {
  test('a run and its differences are stored together', async () => {
    await withTestDb(async (tx) => {
      const seeded = await seedHolding(tx);
      const summary = {
        compared: 7,
        matched: 4,
        byCategory: { 'ledger-ahead-of-anchor': 2, 'starts-at': 1 },
        unlabelled: { holdings: 1, observations: 2, entries: 3 },
        excluded: { 'fabricated-observation': 1 },
        durationMs: 1234,
      };
      const runId = await repo().recordRun(
        runInput({
          asOf: new Date('2026-03-01T00:00:00Z'),
          startedAt: new Date(FUTURE),
          finishedAt: new Date(FUTURE + MINUTE),
          summary,
          differences: [
            difference({
              ...seeded,
              category: 'ledger-ahead-of-anchor',
              at: new Date('2026-03-01T00:00:00Z'),
              engineValue: '105',
              legacyValue: '100',
              detail: { kind: 'feed', method: 'anchor-forward' },
            }),
            difference({
              ...seeded,
              comparator: 'balance-at-time',
              category: 'ledger-ahead-of-anchor',
              at: new Date('2026-02-01T00:00:00Z'),
            }),
            difference({
              userId: seeded.userId,
              category: 'starts-at',
              at: new Date('2026-01-01T00:00:00Z'),
              engineValue: null,
              legacyValue: '3',
            }),
          ],
        }),
        tx
      );

      const [run] = await tx
        .select()
        .from(schema.engineShadowRuns)
        .where(eq(schema.engineShadowRuns.id, runId));
      expect(run).toMatchObject({
        kind: 'balance',
        status: 'complete',
        asOf: new Date('2026-03-01T00:00:00Z'),
        startedAt: new Date(FUTURE),
        finishedAt: new Date(FUTURE + MINUTE),
        error: null,
      });
      expect(run?.summary).toEqual(summary);

      const rows = await differencesOf(tx, runId);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.runId)).toEqual([runId, runId, runId]);
      expect(rows[0]).toMatchObject({
        userId: seeded.userId,
        holdingId: null,
        tokenId: null,
        baseTokenId: null,
        comparator: 'stored-balance',
        category: 'starts-at',
        engineValue: null,
        legacyValue: '3',
        detail: {},
      });
      expect(rows[2]).toMatchObject({
        ...seeded,
        comparator: 'stored-balance',
        category: 'ledger-ahead-of-anchor',
        at: new Date('2026-03-01T00:00:00Z'),
        engineValue: '105',
        legacyValue: '100',
        detail: { kind: 'feed', method: 'anchor-forward' },
      });
    });
  });

  test('a failed run keeps its error', async () => {
    await withTestDb(async (tx) => {
      const runId = await repo().recordRun(
        runInput({ kind: 'price', status: 'failed', error: 'user 42: boom' }),
        tx
      );
      const [run] = await tx
        .select()
        .from(schema.engineShadowRuns)
        .where(eq(schema.engineShadowRuns.id, runId));
      expect(run).toMatchObject({ kind: 'price', status: 'failed', error: 'user 42: boom' });
    });
  });

  // Postgres takes at most 65,535 parameters per statement, and a difference
  // row carries 11. 6,000 fully populated rows in one INSERT would be 66,000.
  test('a run with more differences than one statement can carry is stored whole', async () => {
    await withTestDb(async (tx) => {
      const seeded = await seedHolding(tx);
      const differences = Array.from({ length: 6000 }, (_, i) =>
        difference({ ...seeded, at: new Date(FUTURE - i * MINUTE), detail: { i } })
      );
      const runId = await repo().recordRun(runInput({ differences }), tx);
      expect(await differencesOf(tx, runId)).toHaveLength(6000);
    });
  });

  test('a reference deleted while the shadow ran is treated as its foreign key treats it', async () => {
    await withTestDb(async (tx) => {
      const kept = await seedHolding(tx);
      const userGone = await seedHolding(tx);
      const refsGone = await seedHolding(tx);
      const differences = [
        difference({ ...kept, engineValue: 'kept' }),
        difference({ userId: userGone.userId, holdingId: userGone.holdingId, engineValue: 'user' }),
        difference({ ...refsGone, engineValue: 'refs' }),
        difference({
          comparator: 'live-resolver',
          category: 'route',
          tokenId: refsGone.baseTokenId,
          baseTokenId: kept.baseTokenId,
          engineValue: 'price',
        }),
      ];
      // Found by the shadow, then deleted before its report is stored.
      await tx.delete(schema.users).where(eq(schema.users.id, userGone.userId));
      await tx.delete(schema.holdings).where(eq(schema.holdings.id, refsGone.holdingId));
      await tx.delete(schema.tokens).where(eq(schema.tokens.id, refsGone.baseTokenId));

      const runId = await repo().recordRun(runInput({ differences }), tx);

      const rows = await differencesOf(tx, runId);
      const stored = Object.fromEntries(
        rows.map((r) => [
          r.engineValue,
          {
            userId: r.userId,
            holdingId: r.holdingId,
            tokenId: r.tokenId,
            baseTokenId: r.baseTokenId,
          },
        ])
      );
      expect(stored).toEqual({
        kept: {
          userId: kept.userId,
          holdingId: kept.holdingId,
          tokenId: kept.tokenId,
          baseTokenId: kept.baseTokenId,
        },
        refs: {
          userId: refsGone.userId,
          holdingId: null,
          tokenId: refsGone.tokenId,
          baseTokenId: null,
        },
        price: { userId: null, holdingId: null, tokenId: null, baseTokenId: kept.baseTokenId },
      });
    });
  });

  test('only the newest 30 runs per kind are kept', async () => {
    await withTestDb(async (tx) => {
      expect(SHADOW_RUNS_KEPT).toBe(30);
      // The price run is older than every balance run, so a prune that ignored
      // the kind would take it first.
      const priceRunId = await repo().recordRun(
        runInput({ kind: 'price', startedAt: new Date(FUTURE - MINUTE) }),
        tx
      );
      const balanceRunIds: string[] = [];
      for (let i = 0; i < 31; i++) {
        balanceRunIds.push(
          await repo().recordRun(
            runInput({
              startedAt: new Date(FUTURE + i * MINUTE),
              differences: i === 0 ? [difference()] : [],
            }),
            tx
          )
        );
      }

      const kept = await tx
        .select({ id: schema.engineShadowRuns.id })
        .from(schema.engineShadowRuns)
        .where(inArray(schema.engineShadowRuns.id, [priceRunId, ...balanceRunIds]));
      const keptIds = new Set(kept.map((r) => r.id));
      expect(keptIds.has(priceRunId)).toBe(true);
      expect(keptIds.has(balanceRunIds[0]!)).toBe(false);
      expect(balanceRunIds.slice(1).every((id) => keptIds.has(id))).toBe(true);
      expect(keptIds.size).toBe(31);
      expect(await differencesOf(tx, balanceRunIds[0]!)).toHaveLength(0);
    });
  });

  test('a backdated run survives its own prune, and the next run prunes it', async () => {
    await withTestDb(async (tx) => {
      const newest: string[] = [];
      for (let i = 1; i <= 30; i++) {
        newest.push(
          await repo().recordRun(runInput({ startedAt: new Date(FUTURE + i * MINUTE) }), tx)
        );
      }
      const backdatedId = await repo().recordRun(
        runInput({ startedAt: new Date(FUTURE - MINUTE), differences: [difference()] }),
        tx
      );

      const found = await repo().findDifferences(backdatedId, { perCategory: 20 }, tx);
      expect(found.unexplained?.map((r) => r.runId)).toEqual([backdatedId]);

      await repo().recordRun(runInput({ startedAt: new Date(FUTURE + 31 * MINUTE) }), tx);

      const left = await tx
        .select({ id: schema.engineShadowRuns.id })
        .from(schema.engineShadowRuns)
        .where(inArray(schema.engineShadowRuns.id, [backdatedId, ...newest]));
      const leftIds = new Set(left.map((r) => r.id));
      expect(leftIds.has(backdatedId)).toBe(false);
      expect(leftIds.has(newest[0]!)).toBe(false);
      expect(leftIds.size).toBe(29);
    });
  });

  test('one-user runs are kept apart from the runs over every user', async () => {
    await withTestDb(async (tx) => {
      // Older than every one-user run, so a prune by kind alone would take it.
      const fullRunId = await repo().recordRun(runInput({ startedAt: new Date(FUTURE) }), tx);
      const userRunIds: string[] = [];
      for (let i = 1; i <= 31; i++) {
        userRunIds.push(
          await repo().recordRun(
            runInput({ scope: 'user', startedAt: new Date(FUTURE + i * MINUTE) }),
            tx
          )
        );
      }

      const kept = await tx
        .select({ id: schema.engineShadowRuns.id, scope: schema.engineShadowRuns.scope })
        .from(schema.engineShadowRuns)
        .where(inArray(schema.engineShadowRuns.id, [fullRunId, ...userRunIds]));
      const keptIds = new Set(kept.map((r) => r.id));
      expect(keptIds.has(fullRunId)).toBe(true);
      expect(keptIds.has(userRunIds[0]!)).toBe(false);
      expect(keptIds.size).toBe(31);
      expect(kept.find((r) => r.id === fullRunId)?.scope).toBe('all');
    });
  });

  test('deleting a run removes its differences', async () => {
    await withTestDb(async (tx) => {
      const runId = await repo().recordRun(
        runInput({ differences: [difference(), difference({ category: 'starts-at' })] }),
        tx
      );
      expect(await differencesOf(tx, runId)).toHaveLength(2);

      await tx.delete(schema.engineShadowRuns).where(eq(schema.engineShadowRuns.id, runId));

      expect(await differencesOf(tx, runId)).toHaveLength(0);
    });
  });
});

describe('findDifferences', () => {
  test('returns at most perCategory rows per category, ordered by at then id', async () => {
    await withTestDb(async (tx) => {
      const base = Date.parse('2026-02-01T00:00:00Z');
      // Ten distinct instants for 25 rows, so ties on `at` exist and only the
      // id can order them; inserted latest-first so insertion order is wrong.
      const many = Array.from({ length: 25 }, (_, i) =>
        difference({ category: 'unexplained', at: new Date(base + ((24 - i) % 10) * MINUTE) })
      );
      const few = [
        difference({ category: 'starts-at', at: new Date(base + MINUTE) }),
        difference({ category: 'starts-at', at: new Date(base) }),
      ];
      const runId = await repo().recordRun(runInput({ differences: [...many, ...few] }), tx);
      const otherRunId = await repo().recordRun(
        runInput({ startedAt: new Date(FUTURE + MINUTE), differences: [difference()] }),
        tx
      );

      const found = await repo().findDifferences(runId, { perCategory: 20 }, tx);

      expect(Object.keys(found).sort()).toEqual(['starts-at', 'unexplained']);
      expect(found.unexplained).toHaveLength(20);
      expect(found['starts-at']).toHaveLength(2);

      const stored = await differencesOf(tx, runId);
      const byAtThenId = (a: { at: Date; id: string }, b: { at: Date; id: string }) =>
        a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const expected = (category: string, n: number) =>
        stored
          .filter((r) => r.category === category)
          .sort(byAtThenId)
          .slice(0, n)
          .map((r) => r.id);
      expect(found.unexplained!.map((r) => r.id)).toEqual(expected('unexplained', 20));
      expect(found['starts-at']!.map((r) => r.id)).toEqual(expected('starts-at', 2));
      expect(
        Object.values(found)
          .flat()
          .every((r) => r.runId === runId && r.runId !== otherRunId)
      ).toBe(true);
    });
  });

  test('a run with no differences finds none', async () => {
    await withTestDb(async (tx) => {
      const runId = await repo().recordRun(runInput(), tx);
      expect(await repo().findDifferences(runId, { perCategory: 20 }, tx)).toEqual({});
    });
  });
});
