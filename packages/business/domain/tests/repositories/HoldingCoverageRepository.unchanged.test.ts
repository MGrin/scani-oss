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

// SC-1448. An IBKR position with no trade inside the statement window has no
// ledger at all, only balance readings. When every reading holds the same
// quantity, the position was simply held, and Returns can count it from the
// first reading.
async function heldPosition(
  tx: Parameters<typeof makeUser>[0],
  balance: string,
  readings: Array<[string, string]>
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
  });
  for (const [at, reading] of readings) {
    await tx.insert(schema.holdingBalanceObservations).values({
      userId: user.id,
      holdingId: holding.id,
      observedAt: new Date(at),
      balance: reading,
      source: 'test-fixture',
    });
  }
  return { id: holding.id, userId: user.id };
}

const repo = () => Container.get(HoldingCoverageRepository);

describe('HoldingCoverageRepository.findUnchangedSinceFirstReading (SC-1448)', () => {
  test('a position with no ledger whose readings never moved is held since its first reading', async () => {
    await withTestDb(async (tx) => {
      const { id } = await heldPosition(tx, '4', [
        ['2026-05-17T04:00:00Z', '4'],
        ['2026-07-21T04:00:00Z', '4'],
        ['2026-08-28T04:00:00Z', '4'],
      ]);
      const found = await repo().findUnchangedSinceFirstReading([id], tx);
      expect(Object.fromEntries(found)).toEqual({ [id]: '2026-05-17' });
    });
  });

  test('CONTROL: one reading that moved keeps it out', async () => {
    await withTestDb(async (tx) => {
      const { id } = await heldPosition(tx, '4', [
        ['2026-05-17T04:00:00Z', '4'],
        ['2026-07-21T04:00:00Z', '3'],
        ['2026-08-28T04:00:00Z', '4'],
      ]);
      expect((await repo().findUnchangedSinceFirstReading([id], tx)).size).toBe(0);
    });
  });

  test('a zero reading never counts as an opening', async () => {
    await withTestDb(async (tx) => {
      const { id } = await heldPosition(tx, '0', [
        ['2026-05-17T04:00:00Z', '0'],
        ['2026-07-21T04:00:00Z', '0'],
      ]);
      expect((await repo().findUnchangedSinceFirstReading([id], tx)).size).toBe(0);
    });
  });

  test('a holding whose balance no longer matches its readings is left out', async () => {
    await withTestDb(async (tx) => {
      const { id } = await heldPosition(tx, '5', [
        ['2026-05-17T04:00:00Z', '4'],
        ['2026-07-21T04:00:00Z', '4'],
      ]);
      expect((await repo().findUnchangedSinceFirstReading([id], tx)).size).toBe(0);
    });
  });

  test('a holding with any transaction is left to its ledger', async () => {
    await withTestDb(async (tx) => {
      const { id, userId } = await heldPosition(tx, '4', [
        ['2026-05-17T04:00:00Z', '4'],
        ['2026-07-21T04:00:00Z', '4'],
      ]);
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: id,
        kind: 'transfer_in',
        quantity: '4',
        occurredAt: new Date('2026-05-01T00:00:00Z'),
      });
      expect((await repo().findUnchangedSinceFirstReading([id], tx)).size).toBe(0);
    });
  });
});
