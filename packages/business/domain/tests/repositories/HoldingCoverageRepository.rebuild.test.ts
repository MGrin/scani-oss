import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../src/repositories/HoldingCoverageRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

// SC-1444. The rollup rebuilds a past balance backward from the holding's
// earliest recorded balance and floors a negative result to zero. A negative
// rebuild means the ledger is missing outflows (an ETH wallet whose gas was
// never recorded, SC-1443), so that holding's history is incomplete.
async function holdingWith(
  tx: Parameters<typeof makeUser>[0],
  balance: string,
  ledger: Array<[string, string]>
): Promise<{ id: string; userId: string }> {
  const user = await makeUser(tx);
  const inst = await makeInstitution(tx, { typeId: (await makeInstitutionType(tx)).id });
  const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const tok = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: acct.id,
    tokenId: tok.id,
    balance,
    lastUpdated: new Date('2026-09-01T00:00:00Z'),
  });
  for (const [at, quantity] of ledger) {
    await makeHoldingTransaction(tx, {
      userId: user.id,
      holdingId: holding.id,
      kind: quantity.startsWith('-') ? 'transfer_out' : 'transfer_in',
      quantity,
      occurredAt: new Date(at),
    });
  }
  return { id: holding.id, userId: user.id };
}

const repo = () => Container.get(HoldingCoverageRepository);

describe('HoldingCoverageRepository.findRebuildGoesNegative (SC-1444)', () => {
  test('a ledger whose outflows outrun the recorded balance rebuilds negative', async () => {
    await withTestDb(async (tx) => {
      // +1 then -0.2 is 0.8 held, but the balance says 0.3: walking back from
      // 0.3 reaches -0.5 before the first inflow.
      const { id } = await holdingWith(tx, '0.3', [
        ['2021-12-14T15:00:00Z', '1'],
        ['2021-12-15T15:00:00Z', '-0.2'],
      ]);
      expect([...(await repo().findRebuildGoesNegative([id], tx))]).toEqual([id]);
    });
  });

  test('CONTROL: a ledger that reconciles to its balance rebuilds to zero, not below', async () => {
    await withTestDb(async (tx) => {
      const { id } = await holdingWith(tx, '0.8', [
        ['2021-12-14T15:00:00Z', '1'],
        ['2021-12-15T15:00:00Z', '-0.2'],
      ]);
      expect((await repo().findRebuildGoesNegative([id], tx)).size).toBe(0);
    });
  });

  test('the anchor is the EARLIEST recorded balance, which the rollup walks back from', async () => {
    await withTestDb(async (tx) => {
      // Reconciles to today's 0.8, but an observation in 2026-05 says 0.3,
      // and the rollup walks the 2021 days back from that one.
      const { id, userId } = await holdingWith(tx, '0.8', [
        ['2021-12-14T15:00:00Z', '1'],
        ['2021-12-15T15:00:00Z', '-0.2'],
      ]);
      await tx.insert(schema.holdingBalanceObservations).values({
        userId,
        holdingId: id,
        observedAt: new Date('2026-05-17T15:00:00Z'),
        balance: '0.3',
        source: 'test-fixture',
      });
      expect([...(await repo().findRebuildGoesNegative([id], tx))]).toEqual([id]);
    });
  });
  test('fee dust under 1% of the holding is not a gap', async () => {
    await withTestDb(async (tx) => {
      // 0.1 BTC held, one fee of 0.0001 never imported: -0.1% of the holding,
      // which the floor absorbs. Excluding the holding for it would be worse.
      const { id } = await holdingWith(tx, '0.0999', [['2021-12-14T15:00:00Z', '0.1']]);
      expect((await repo().findRebuildGoesNegative([id], tx)).size).toBe(0);
    });
  });
});
