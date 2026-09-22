/**
 * SC-1283. The rollup used to prefetch EVERY observation of every holding for
 * each 30-day chunk — 112k rows on the portfolio that exhausted the worker —
 * when BalanceAtTimeService only ever reads three of them per holding per day:
 * the first one, and the nearest at-or-before and at-or-after the instant.
 * `findAnchorsForInstants` returns exactly those, so the lookups over its
 * result must answer as they did over the full history.
 */

import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import type { HoldingBalanceObservation } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../src/repositories/HoldingBalanceObservationRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingBalanceObservationRepository);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-05-01T00:00:00Z');

// The whole history, as the rollup used to prefetch it.
const fullHistory = (tx: DatabaseTransaction, holdingId: string) =>
  tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
    .orderBy(asc(schema.holdingBalanceObservations.observedAt));

// The two scans BalanceAtTimeService runs over a cached list.
const atOrAfter = (rows: readonly HoldingBalanceObservation[], at: number) =>
  rows.find((o) => o.observedAt.getTime() >= at) ?? null;
const atOrBefore = (rows: readonly HoldingBalanceObservation[], at: number) => {
  let best: HoldingBalanceObservation | null = null;
  for (const o of rows) {
    if (o.observedAt.getTime() <= at) best = o;
    else break;
  }
  return best;
};

describe('HoldingBalanceObservationRepository.findAnchorsForInstants', () => {
  test('answers every per-day lookup as the full history does, from a bounded set', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const instType = await makeInstitutionType(tx);
      const inst = await makeInstitution(tx, { typeId: instType.id });
      const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const dense = await makeHolding(tx, {
        userId: user.id,
        accountId: acct.id,
        tokenId: (await makeToken(tx)).id,
      });
      const sparse = await makeHolding(tx, {
        userId: user.id,
        accountId: acct.id,
        tokenId: (await makeToken(tx)).id,
      });
      const empty = await makeHolding(tx, {
        userId: user.id,
        accountId: acct.id,
        tokenId: (await makeToken(tx)).id,
      });

      // Hourly for 60 days, like a synced wallet.
      await repo().bulkAppend(
        Array.from({ length: 60 * 24 }, (_, i) => ({
          userId: user.id,
          holdingId: dense.id,
          balance: String(i),
          observedAt: new Date(START + i * HOUR),
          source: 'sync-capture',
        })),
        tx
      );
      // Three observations weeks apart, one of them twice at the same instant.
      await repo().bulkAppend(
        [
          { at: START + 5 * DAY, source: 'manual', balance: '1' },
          { at: START + 30 * DAY, source: 'manual', balance: '2' },
          { at: START + 30 * DAY, source: 'sync-capture', balance: '3' },
          { at: START + 50 * DAY, source: 'manual', balance: '4' },
        ].map((o) => ({
          userId: user.id,
          holdingId: sparse.id,
          balance: o.balance,
          observedAt: new Date(o.at),
          source: o.source,
        })),
        tx
      );

      const ids = [dense.id, sparse.id, empty.id];

      // A 30-day chunk's instants, end-of-day like the rollup, reaching past
      // both ends of the observed range and landing exactly on one row.
      const instants = Array.from(
        { length: 30 },
        (_, i) => new Date(START + (40 - i) * DAY + DAY - 1)
      );
      instants.push(new Date(START + 30 * DAY), new Date(START - 10 * DAY));
      const scoped = await repo().findAnchorsForInstants(ids, instants, tx);

      for (const id of ids) {
        const all = await fullHistory(tx, id);
        const got = scoped.get(id);
        expect(got).toBeDefined();
        expect(got?.[0]?.id).toBe(all[0]?.id);
        for (const at of instants) {
          const t = at.getTime();
          expect(atOrAfter(got ?? [], t)?.observedAt).toEqual(atOrAfter(all, t)?.observedAt);
          expect(atOrBefore(got ?? [], t)?.observedAt).toEqual(atOrBefore(all, t)?.observedAt);
        }
        const times = (got ?? []).map((o) => o.observedAt.getTime());
        expect(times).toEqual([...times].sort((a, b) => a - b));
      }

      // The point: first + two per instant at most, not the whole history.
      expect(await fullHistory(tx, dense.id)).toHaveLength(1440);
      expect((scoped.get(dense.id) ?? []).length).toBeLessThanOrEqual(1 + 2 * instants.length);
      // Tied rows at a chosen instant travel together.
      expect(
        (scoped.get(sparse.id) ?? []).filter((o) => o.observedAt.getTime() === START + 30 * DAY)
      ).toHaveLength(2);
      expect(scoped.get(empty.id)).toEqual([]);
    });
  });

  test('no holdings reads nothing; no instants still returns the first row', async () => {
    await withTestDb(async (tx) => {
      expect((await repo().findAnchorsForInstants([], [new Date()], tx)).size).toBe(0);
      const user = await makeUser(tx);
      const instType = await makeInstitutionType(tx);
      const inst = await makeInstitution(tx, { typeId: instType.id });
      const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const h = await makeHolding(tx, {
        userId: user.id,
        accountId: acct.id,
        tokenId: (await makeToken(tx)).id,
      });
      await repo().append(
        {
          userId: user.id,
          holdingId: h.id,
          balance: '1',
          observedAt: new Date(START),
          source: 'manual',
        },
        tx
      );
      // No instants still carries the first row: earliestEvidenceAt reads it.
      const got = await repo().findAnchorsForInstants([h.id], [], tx);
      expect(got.get(h.id)?.map((o) => o.balance)).toEqual(['1']);
    });
  });
});
