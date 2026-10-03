import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { settlementMetadata } from '../../src/lib/transactions/trade-settlement';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

/**
 * SC-1396's exact-amount re-point lets an imported row take over a person's
 * balance-gap answer of the same kind and amount. A settlement leg is derived
 * rather than reported, so it must never do that: an answer the settlements
 * make redundant is retired only by the person, through the settlement review
 * (SC-858, SC-1453).
 */

const repo = () => Container.get(HoldingTransactionRepository);

async function answeredCash(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx);
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const usd = await makeToken(tx);
  const cash = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });
  const {
    rows: [answer],
  } = await repo().bulkUpsert(
    [
      {
        userId: user.id,
        holdingId: cash.id,
        tokenId: usd.id,
        kind: 'fee',
        quantity: '-1',
        occurredAt: new Date('2026-07-10T00:00:00Z'),
        source: 'user-balance-edit',
        externalId: 'gap-answer-1',
        sourceMetadata: {
          gapObservationId: 'obs-1',
          gapFrom: '2026-07-01T00:00:00.000Z',
          gapTo: '2026-07-31T00:00:00.000Z',
        },
      },
    ],
    tx
  );
  if (!answer) throw new Error('answer not written');
  return { userId: user.id, usd: usd.id, cash: cash.id, answer };
}

function importedFee(f: Awaited<ReturnType<typeof answeredCash>>, sourceMetadata: object) {
  return {
    userId: f.userId,
    holdingId: f.cash,
    tokenId: f.usd,
    kind: 'fee',
    quantity: '-1',
    occurredAt: new Date('2026-07-14T14:30:00Z'),
    source: 'ibkr-api',
    externalId: 'ibkr-trade-1:fee',
    sourceMetadata,
  };
}

async function cashRows(tx: DatabaseTransaction, holdingId: string) {
  return tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.holdingId, holdingId));
}

describe('bulkUpsert re-point and settlement legs', () => {
  test('control: a reported fee of the same amount inside the gap takes over the answer', async () => {
    await withTestDb(async (tx) => {
      const f = await answeredCash(tx);
      await repo().bulkUpsert([importedFee(f, {})], tx);

      const rows = await cashRows(tx, f.cash);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: f.answer.id,
        source: 'ibkr-api',
        externalId: 'ibkr-trade-1:fee',
      });
    });
  });

  test("a settlement fee leg lands as its own row and leaves the person's answer untouched", async () => {
    await withTestDb(async (tx) => {
      const f = await answeredCash(tx);
      await repo().bulkUpsert([importedFee(f, settlementMetadata('ibkr-trade-1'))], tx);

      const rows = await cashRows(tx, f.cash);
      expect(rows).toHaveLength(2);
      const answer = rows.find((r) => r.id === f.answer.id);
      expect(answer).toMatchObject({
        source: 'user-balance-edit',
        externalId: 'gap-answer-1',
        quantity: '-1',
        sourceMetadata: f.answer.sourceMetadata,
      });
      expect(rows.find((r) => r.id !== f.answer.id)).toMatchObject({
        source: 'ibkr-api',
        kind: 'fee',
        externalId: 'ibkr-trade-1:fee',
        sourceMetadata: { settles: 'ibkr-trade-1' },
      });
    });
  });
});
