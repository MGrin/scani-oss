import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import type { UserJobState } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { Container } from 'typedi';
import { PlanHistoryRecomputeUseCase } from '../../src/use-cases/PlanHistoryRecomputeUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { makeHoldingTransaction, makeToken } from '../../test/helpers/factories-extra';

/**
 * Who a history recompute reaches: the SC-1142 trade-fee cohort, and the
 * SC-1323 stored-history cohort.
 *
 * The test database is shared, so every assertion is about the users made
 * here — membership, never a count.
 */

const JOB = 'portfolio-history-backfill';
const jobIdFor = (userId: string) => `${JOB}_${userId}_sc1142-trade-fees`;
const SINCE = new Date('2025-08-21T00:00:00Z');
const plan = (tx: DatabaseTransaction, userId?: string) =>
  Container.get(PlanHistoryRecomputeUseCase).execute(
    { cohort: 'trade-fees', jobIdFor, since: SINCE, userId },
    tx
  );
const planStored = (tx: DatabaseTransaction, userId?: string) =>
  Container.get(PlanHistoryRecomputeUseCase).execute(
    { cohort: 'stored-history', jobIdFor, since: SINCE, userId },
    tx
  );

async function userWithFees(
  tx: DatabaseTransaction,
  fees: Array<string | null>,
  opts: { baseCurrency?: boolean } = {}
): Promise<string> {
  const currency = await makeToken(tx);
  const user = await makeUser(
    tx,
    opts.baseCurrency === false ? {} : { baseCurrencyId: currency.id }
  );
  for (const feeQuantity of fees) {
    await makeHoldingTransaction(tx, {
      userId: user.id,
      kind: 'buy',
      quantity: '1',
      feeQuantity,
      feeTokenId: feeQuantity === null ? null : currency.id,
    });
  }
  return user.id;
}

async function recordJob(tx: DatabaseTransaction, userId: string, state: UserJobState) {
  await tx.insert(schema.userJobs).values({ jobId: jobIdFor(userId), userId, jobName: JOB, state });
}

describe('PlanHistoryRecomputeUseCase — trade-fees (SC-1142)', () => {
  test('selects a user with a fee, and only users with one', async () => {
    await withTestDb(async (tx) => {
      const withFee = await userWithFees(tx, [null, '-0.5']);
      const noFee = await userWithFees(tx, [null, null]);
      const zeroFees = await userWithFees(tx, ['0', '-0.00', '', '  0 ']);
      const noBaseCurrency = await userWithFees(tx, ['-1'], { baseCurrency: false });

      const { toEnqueue } = await plan(tx);
      expect(toEnqueue).toContain(withFee);
      expect(toEnqueue).not.toContain(noFee);
      expect(toEnqueue).not.toContain(zeroFees);
      expect(toEnqueue).not.toContain(noBaseCurrency);
    });
  });

  test('selects a fee the walk cannot read, because the walk grades it partial', async () => {
    await withTestDb(async (tx) => {
      const unreadable = await userWithFees(tx, ['about a dollar']);
      expect((await plan(tx)).toEnqueue).toContain(unreadable);
    });
  });

  test('skips a user already recomputed or in flight, and retries one that failed', async () => {
    await withTestDb(async (tx) => {
      const done = await userWithFees(tx, ['-1']);
      const running = await userWithFees(tx, ['-1']);
      const failed = await userWithFees(tx, ['-1']);
      const fresh = await userWithFees(tx, ['-1']);
      await recordJob(tx, done, 'completed');
      await recordJob(tx, running, 'active');
      await recordJob(tx, failed, 'failed');

      const result = await plan(tx);
      expect(result.completed).toContain(done);
      expect(result.inFlight).toContain(running);
      expect(result.toEnqueue).toContain(failed);
      expect(result.toEnqueue).toContain(fresh);
      expect(result.toEnqueue).not.toContain(done);
      expect(result.toEnqueue).not.toContain(running);
    });
  });

  test('a job recorded under another request id does not count as this recompute', async () => {
    await withTestDb(async (tx) => {
      const user = await userWithFees(tx, ['-1']);
      await tx.insert(schema.userJobs).values({
        jobId: `${JOB}_${user}_mutation-123`,
        userId: user,
        jobName: JOB,
        state: 'completed',
      });
      expect((await plan(tx)).toEnqueue).toContain(user);
    });
  });

  test('--user narrows the plan to that one user', async () => {
    await withTestDb(async (tx) => {
      const one = await userWithFees(tx, ['-1']);
      const other = await userWithFees(tx, ['-1']);
      const result = await plan(tx, one);
      expect(result.toEnqueue).toEqual([one]);
      expect(result.toEnqueue).not.toContain(other);
    });
  });
});

async function userWithHistory(
  tx: DatabaseTransaction,
  days: string[],
  opts: { baseCurrency?: boolean; scopeKind?: string } = {}
): Promise<string> {
  const currency = await makeToken(tx);
  const user = await makeUser(
    tx,
    opts.baseCurrency === false ? {} : { baseCurrencyId: currency.id }
  );
  for (const snapshotDate of days) {
    await tx.insert(schema.portfolioValueDaily).values({
      userId: user.id,
      scopeKind: opts.scopeKind ?? 'user',
      scopeId: user.id,
      snapshotDate,
      baseCurrencyId: currency.id,
      totalValue: '1',
      coverageQuality: 'full',
      holdingsWithKnownValue: 1,
      holdingsTotal: 1,
    });
  }
  return user.id;
}

describe('PlanHistoryRecomputeUseCase — stored-history (SC-1323)', () => {
  test('selects a user with a stored day in the window, and only those', async () => {
    await withTestDb(async (tx) => {
      const inWindow = await userWithHistory(tx, ['2025-06-01', '2026-09-01']);
      const onBoundary = await userWithHistory(tx, ['2025-08-21']);
      const beforeWindow = await userWithHistory(tx, ['2025-08-20']);
      const noHistory = await userWithHistory(tx, []);
      const noBaseCurrency = await userWithHistory(tx, ['2026-09-01'], { baseCurrency: false });

      const { toEnqueue } = await planStored(tx);
      expect(toEnqueue).toContain(inWindow);
      expect(toEnqueue).toContain(onBoundary);
      expect(toEnqueue).not.toContain(beforeWindow);
      expect(toEnqueue).not.toContain(noHistory);
      expect(toEnqueue).not.toContain(noBaseCurrency);
    });
  });

  test('a user-scope row is what counts; an entity-scope row alone does not select', async () => {
    await withTestDb(async (tx) => {
      const entityOnly = await userWithHistory(tx, ['2026-09-01'], { scopeKind: 'holding' });
      expect((await planStored(tx)).toEnqueue).not.toContain(entityOnly);
    });
  });

  test('a user done by the trade-fee cohort is still selected here', async () => {
    await withTestDb(async (tx) => {
      const user = await userWithHistory(tx, ['2026-09-01']);
      await tx.insert(schema.userJobs).values({
        jobId: `${JOB}_${user}_sc1142-trade-fees`,
        userId: user,
        jobName: JOB,
        state: 'completed',
      });
      const stored = (id: string) => `${JOB}_${id}_sc1323-evidence-absent`;
      const result = await Container.get(PlanHistoryRecomputeUseCase).execute(
        { cohort: 'stored-history', jobIdFor: stored, since: SINCE, userId: user },
        tx
      );
      expect(result.toEnqueue).toEqual([user]);
    });
  });

  test('--user narrows the plan to that one user', async () => {
    await withTestDb(async (tx) => {
      const one = await userWithHistory(tx, ['2026-09-01']);
      await userWithHistory(tx, ['2026-09-01']);
      expect((await planStored(tx, one)).toEnqueue).toEqual([one]);
    });
  });
});
