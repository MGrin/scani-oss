import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import type { UserJobState } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { Container } from 'typedi';
import { PlanTradeFeeRecomputeUseCase } from '../../src/use-cases/PlanTradeFeeRecomputeUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { makeHoldingTransaction, makeToken } from '../../test/helpers/factories-extra';

/**
 * Who the SC-1142 recompute reaches.
 *
 * The test database is shared, so every assertion is about the users made
 * here — membership, never a count.
 */

const JOB = 'portfolio-history-backfill';
const jobIdFor = (userId: string) => `${JOB}_${userId}_sc1142-trade-fees`;
const plan = (tx: DatabaseTransaction, userId?: string) =>
  Container.get(PlanTradeFeeRecomputeUseCase).execute({ jobIdFor, userId }, tx);

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

describe('PlanTradeFeeRecomputeUseCase (SC-1142)', () => {
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
