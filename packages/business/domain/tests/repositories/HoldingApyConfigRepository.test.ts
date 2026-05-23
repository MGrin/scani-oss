import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingApyConfigRepository } from '../../src/repositories/HoldingApyConfigRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// HoldingApyConfigRepository drives the APY scheduler cron. The upsert is
// where silent bugs live — `onConflictDoUpdate` must also reset
// `lastPayoutAt` so a rate change doesn't accidentally backfill a year of
// accrued interest on the next tick. Pin that invariant.

const repo = () => Container.get(HoldingApyConfigRepository);

async function scaffoldHolding(
  tx: Parameters<Parameters<typeof import('../../test/helpers/db').withTestDb>[0]>[0]
) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
  });
  return { user, account, holding };
}

describe('HoldingApyConfigRepository', () => {
  test('upsertByHoldingId inserts a fresh row when none exists', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffoldHolding(tx);
      const row = await repo().upsertByHoldingId(
        holding.id,
        { annualRatePct: '4.5', payoutFrequency: 'monthly', payoutDayOfMonth: 1 },
        tx
      );
      expect(row.annualRatePct).toBe('4.5');
      expect(row.payoutFrequency).toBe('monthly');
    });
  });

  test('upsertByHoldingId resets lastPayoutAt when rate changes', async () => {
    // Reason: if a user bumps their savings APY from 4% → 5%, we must not
    // retroactively pay 5% for the prior period — lastPayoutAt gets reset
    // so accrual resumes from "now".
    await withTestDb(async (tx) => {
      const { holding } = await scaffoldHolding(tx);
      await repo().upsertByHoldingId(
        holding.id,
        { annualRatePct: '4.0', payoutFrequency: 'daily' },
        tx
      );
      const before = new Date();
      const updated = await repo().upsertByHoldingId(
        holding.id,
        { annualRatePct: '5.0', payoutFrequency: 'daily' },
        tx
      );
      expect(updated.annualRatePct).toBe('5.0');
      expect(updated.lastPayoutAt).not.toBeNull();
      expect((updated.lastPayoutAt as Date).getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000
      );
    });
  });

  test('findByHoldingIds short-circuits on empty input', async () => {
    await withTestDb(async (tx) => {
      expect((await repo().findByHoldingIds([], tx)).size).toBe(0);
    });
  });

  test('findByHoldingIds returns a map keyed by holdingId', async () => {
    await withTestDb(async (tx) => {
      const { holding: h1 } = await scaffoldHolding(tx);
      const { holding: h2 } = await scaffoldHolding(tx);
      await repo().upsertByHoldingId(h1.id, { annualRatePct: '1', payoutFrequency: 'daily' }, tx);
      await repo().upsertByHoldingId(
        h2.id,
        { annualRatePct: '2', payoutFrequency: 'weekly', payoutDayOfWeek: 5 },
        tx
      );
      const map = await repo().findByHoldingIds([h1.id, h2.id], tx);
      expect(map.size).toBe(2);
      expect(map.get(h1.id)?.annualRatePct).toBe('1');
      expect(map.get(h2.id)?.annualRatePct).toBe('2');
    });
  });

  test('deleteByHoldingId returns true when a row was removed, false otherwise', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffoldHolding(tx);
      await repo().upsertByHoldingId(
        holding.id,
        { annualRatePct: '1', payoutFrequency: 'daily' },
        tx
      );
      expect(await repo().deleteByHoldingId(holding.id, tx)).toBe(true);
      expect(await repo().deleteByHoldingId(holding.id, tx)).toBe(false);
    });
  });
});
