import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  BalanceGapAnswerRejected,
  BalanceGapService,
} from '../../../src/services/holdings/BalanceGapService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

async function fixture(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const token = await makeToken(tx);
  const institution = await makeInstitution(tx);
  const sourceAccount = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const destinationAccount = await makeAccount(tx, {
    userId: user.id,
    institutionId: institution.id,
  });
  const source = await makeHolding(tx, {
    userId: user.id,
    accountId: sourceAccount.id,
    tokenId: token.id,
    balance: '800',
    source: 'wallet',
  });
  const destination = await makeHolding(tx, {
    userId: user.id,
    accountId: destinationAccount.id,
    tokenId: token.id,
    balance: '700',
    source: 'manual',
  });
  const [opening, closing] = await tx
    .insert(schema.holdingBalanceObservations)
    .values([
      {
        userId: user.id,
        holdingId: source.id,
        balance: '1000',
        observedAt: new Date('2026-01-01T00:00:00Z'),
        source: 'sync-capture',
      },
      {
        userId: user.id,
        holdingId: source.id,
        balance: '800',
        observedAt: new Date('2026-01-03T00:00:00Z'),
        source: 'sync-capture',
      },
    ])
    .returning();
  await tx.insert(schema.holdingBalanceObservations).values({
    userId: user.id,
    holdingId: destination.id,
    balance: '700',
    observedAt: new Date('2026-01-04T00:00:00Z'),
    source: 'sync-capture',
  });
  return { user, source, destination, opening: opening!, closing: closing! };
}

describe('Atomic balance gap review', () => {
  test('historical transfer is answered once without moving an observed destination anchor again', async () => {
    await withTestDb(async (tx) => {
      const { user, source, destination, closing } = await fixture(tx);
      const service = new BalanceGapService();
      const input = {
        observationId: closing.id,
        answer: 'flow' as const,
        editOutflow: {
          decision: 'internal' as const,
          destination: { accountId: destination.accountId, holdingId: destination.id },
          feeQuantity: '5',
        },
      };
      const result = await service.answer(user.id, input, new Date(), tx);
      expect(result).toHaveProperty('result');
      expect(await service.answer(user.id, input, new Date(), tx)).toEqual(result);
      const rows = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.userId, user.id));
      expect(
        rows
          .filter((row) => row.holdingId === source.id)
          .map((row) => row.quantity)
          .sort()
      ).toEqual(['-195', '-5']);
      expect(rows.find((row) => row.holdingId === destination.id)?.quantity).toBe('195');
      expect(rows.find((row) => row.kind === 'withdraw')?.transferReview).toBe('internal');
      const [holding] = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, destination.id));
      expect(holding!.balance).toBe('700');
    });
  });
  test('a foreign destination rolls back the movement and the review stamp', async () => {
    await withTestDb(async (tx) => {
      const { user, source, destination, closing } = await fixture(tx);
      const stranger = await makeUser(tx);
      await tx
        .update(schema.holdings)
        .set({ userId: stranger.id })
        .where(eq(schema.holdings.id, destination.id));
      await expect(
        tx.transaction((inner) =>
          new BalanceGapService().answer(
            user.id,
            {
              observationId: closing.id,
              answer: 'flow',
              editOutflow: {
                decision: 'internal',
                destination: { accountId: destination.accountId, holdingId: destination.id },
              },
            },
            new Date(),
            inner
          )
        )
      ).rejects.toThrow();
      expect(
        await tx
          .select()
          .from(schema.holdingTransactions)
          .where(eq(schema.holdingTransactions.holdingId, source.id))
      ).toHaveLength(0);
      const [observation] = await tx
        .select()
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.id, closing.id));
      expect(observation!.gapReview).toBeNull();
    });
  });
});

test('late imports replace the reviewed event and arrival, retries stay single, and undo preserves observed facts', async () => {
  await withTestDb(async (tx) => {
    const { user, source, destination, closing } = await fixture(tx);
    const service = new BalanceGapService();
    const input = {
      observationId: closing.id,
      answer: 'flow' as const,
      editOutflow: {
        decision: 'internal' as const,
        destination: { accountId: destination.accountId, holdingId: destination.id },
      },
    };
    await service.answer(user.id, input, new Date(), tx);
    const repository = new HoldingTransactionRepository();
    const rows = [
      {
        userId: user.id,
        holdingId: source.id,
        tokenId: source.tokenId,
        kind: 'withdraw' as const,
        quantity: '-200',
        source: 'test-import',
        externalId: 'out',
        occurredAt: new Date('2026-01-03T00:00:00Z'),
      },
      {
        userId: user.id,
        holdingId: destination.id,
        tokenId: destination.tokenId,
        kind: 'deposit' as const,
        quantity: '200',
        source: 'test-import',
        externalId: 'in',
        occurredAt: new Date('2026-01-03T00:00:00Z'),
      },
    ];
    await repository.bulkUpsert(rows, tx);
    await repository.bulkUpsert(rows, tx);
    const actual = await tx
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, user.id));
    expect(actual).toHaveLength(2);
    expect(actual[0]!.transferGroupId).toBe(actual[1]!.transferGroupId);
    expect(actual.find((row) => row.kind === 'withdraw')!.transferReview).toBe('internal');
    expect(await service.undo(user.id, closing.id, tx)).toBe(true);
    expect(await service.undo(user.id, closing.id, tx)).toBe(false);
    const retained = await tx
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, user.id));
    expect(retained).toHaveLength(2);
    expect(retained.every((row) => row.transferGroupId === null)).toBe(true);
    const [holding] = await tx
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, destination.id));
    expect(holding!.balance).toBe('700');
  });
});

test('undo removes only synthesized gap explanation and fee without moving either observed balance', async () => {
  await withTestDb(async (tx) => {
    const { user, source, destination, closing } = await fixture(tx);
    const service = new BalanceGapService();
    await service.answer(
      user.id,
      {
        observationId: closing.id,
        answer: 'flow',
        editOutflow: {
          decision: 'internal',
          feeQuantity: '5',
          destination: { accountId: destination.accountId, holdingId: destination.id },
        },
      },
      new Date(),
      tx
    );
    expect(await service.undo(user.id, closing.id, tx)).toBe(true);
    expect(
      await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.userId, user.id))
    ).toHaveLength(0);
    const [holding] = await tx
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, source.id));
    expect(holding!.balance).toBe('800');
    expect(
      await service.answer(
        user.id,
        { observationId: closing.id, answer: 'unknown' },
        new Date(),
        tx
      )
    ).toHaveProperty('result');
  });
});

test('a historical cross-currency move records the stated arrival and source fee once', async () => {
  await withTestDb(async (tx) => {
    const { user, source, destination, closing } = await fixture(tx);
    const euro = await makeToken(tx);
    await tx
      .update(schema.holdings)
      .set({ tokenId: euro.id })
      .where(eq(schema.holdings.id, destination.id));
    const service = new BalanceGapService();
    await service.answer(
      user.id,
      {
        observationId: closing.id,
        answer: 'flow',
        receivedQuantity: '180',
        editOutflow: {
          decision: 'internal',
          feeQuantity: '5',
          destination: { accountId: destination.accountId, holdingId: destination.id },
        },
      },
      new Date(),
      tx
    );
    const rows = await tx
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, user.id));
    expect(rows.find((row) => row.holdingId === destination.id)).toMatchObject({
      tokenId: euro.id,
      quantity: '180',
    });
    expect(
      rows
        .filter((row) => row.holdingId === source.id)
        .map((row) => row.quantity)
        .sort()
    ).toEqual(['-195', '-5']);
    expect(await service.undo(user.id, closing.id, tx)).toBe(true);
    expect(
      await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.userId, user.id))
    ).toHaveLength(0);
  });
});

test('a later import replaces the gap answer’s fee as well as its withdrawal (SC-1396)', async () => {
  await withTestDb(async (tx) => {
    const { user, source, destination, closing } = await fixture(tx);
    await new BalanceGapService().answer(
      user.id,
      {
        observationId: closing.id,
        answer: 'flow',
        editOutflow: {
          decision: 'internal',
          destination: { accountId: destination.accountId, holdingId: destination.id },
          feeQuantity: '5',
        },
      },
      new Date(),
      tx
    );
    const imported = {
      userId: user.id,
      holdingId: source.id,
      tokenId: source.tokenId,
      source: 'test-import',
      occurredAt: new Date('2026-01-02T12:00:00Z'),
    };
    await new HoldingTransactionRepository().bulkUpsert(
      [
        { ...imported, kind: 'withdraw' as const, quantity: '-195', externalId: 'out' },
        { ...imported, kind: 'fee' as const, quantity: '-5', externalId: 'out:fee' },
      ],
      tx
    );
    const sourceRows = await tx
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.holdingId, source.id));
    expect(sourceRows.map((row) => row.quantity).sort()).toEqual(['-195', '-5']);
    expect(sourceRows.every((row) => row.source === 'test-import')).toBe(true);
  });
});

test('a destination on money that arrived is a readable rejection, and writes nothing (SC-1396)', async () => {
  await withTestDb(async (tx) => {
    const { user, source, destination } = await fixture(tx);
    const [rise] = await tx
      .insert(schema.holdingBalanceObservations)
      .values({
        userId: user.id,
        holdingId: source.id,
        balance: '900',
        observedAt: new Date('2026-01-05T00:00:00Z'),
        source: 'sync-capture',
      })
      .returning();
    const attempt = tx.transaction((inner) =>
      new BalanceGapService().answer(
        user.id,
        {
          observationId: rise!.id,
          answer: 'flow',
          editOutflow: {
            decision: 'internal',
            destination: { accountId: destination.accountId, holdingId: destination.id },
          },
        },
        new Date(),
        inner
      )
    );
    await expect(attempt).rejects.toBeInstanceOf(BalanceGapAnswerRejected);
    expect(
      await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.userId, user.id))
    ).toEqual([]);
  });
});

describe('a later deposit replaces the answer’s arrival within the arrival window (SC-1400)', () => {
  async function answerThenImport(
    tx: DatabaseTransaction,
    deposits: { externalId: string; occurredAt: string }[]
  ) {
    const { user, destination, closing } = await fixture(tx);
    await new BalanceGapService().answer(
      user.id,
      {
        observationId: closing.id,
        answer: 'flow',
        editOutflow: {
          decision: 'internal',
          destination: { accountId: destination.accountId, holdingId: destination.id },
        },
      },
      new Date(),
      tx
    );
    await new HoldingTransactionRepository().bulkUpsert(
      deposits.map((d) => ({
        userId: user.id,
        holdingId: destination.id,
        tokenId: destination.tokenId,
        kind: 'deposit' as const,
        quantity: '200',
        source: 'test-import',
        externalId: d.externalId,
        occurredAt: new Date(d.occurredAt),
      })),
      tx
    );
    return tx
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.holdingId, destination.id));
  }

  test('a deposit five hours after the outflow is the same money: one arrival, still paired', async () => {
    await withTestDb(async (tx) => {
      const rows = await answerThenImport(tx, [
        { externalId: 'in', occurredAt: '2026-01-03T05:00:00Z' },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe('test-import');
      expect(rows[0]!.transferGroupId).not.toBeNull();
    });
  });

  test('CONTROL: a deposit eight days later is a different deposit and is kept beside it', async () => {
    await withTestDb(async (tx) => {
      const rows = await answerThenImport(tx, [
        { externalId: 'in', occurredAt: '2026-01-11T05:00:00Z' },
      ]);
      expect(rows.map((r) => r.source).sort()).toEqual(['test-import', 'transfer-review']);
    });
  });

  test('CONTROL: two same-amount deposits in the window are not guessed between', async () => {
    await withTestDb(async (tx) => {
      const rows = await answerThenImport(tx, [
        { externalId: 'a', occurredAt: '2026-01-03T05:00:00Z' },
        { externalId: 'b', occurredAt: '2026-01-04T05:00:00Z' },
      ]);
      expect(rows.map((r) => r.source).sort()).toEqual([
        'test-import',
        'test-import',
        'transfer-review',
      ]);
    });
  });
});

/**
 * SC-1665 Part 2. A gap whose money went to several places is answered in
 * parts. The service writes one withdrawal for the drift and divides it with
 * the transfer review's split, so each move lands in one transfer group.
 */
describe('a balance gap answered in parts (SC-1665)', () => {
  async function secondDestination(tx: DatabaseTransaction, userId: string, tokenId: string) {
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId, institutionId: institution.id });
    return makeHolding(tx, { userId, accountId: account.id, tokenId, source: 'manual' });
  }

  test('one withdrawal, one arrival per destination, one group, and undo takes them all', async () => {
    await withTestDb(async (tx) => {
      const { user, source, destination, closing } = await fixture(tx);
      const wise = await secondDestination(tx, user.id, source.tokenId);
      const service = new BalanceGapService();
      const input = {
        observationId: closing.id,
        answer: 'flow' as const,
        parts: [
          {
            decision: 'internal' as const,
            quantity: '120',
            destination: { accountId: destination.accountId, holdingId: destination.id },
          },
          {
            decision: 'internal' as const,
            quantity: '50',
            destination: { accountId: wise.accountId, holdingId: wise.id },
          },
          { decision: 'left_control' as const, quantity: '30' },
        ],
      };
      const result = await service.answer(user.id, input, new Date(), tx);
      expect(result).toHaveProperty('result');
      expect(await service.answer(user.id, input, new Date(), tx)).toEqual(result);

      const rows = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.userId, user.id));
      const withdrawal = rows.find((row) => row.holdingId === source.id);
      expect(withdrawal?.quantity).toBe('-200');
      expect(withdrawal?.transferReview).toBe('split');
      const arrivals = new Map(
        rows.filter((row) => row.kind === 'transfer_in').map((row) => [row.holdingId, row])
      );
      expect(arrivals.get(destination.id)?.quantity).toBe('120');
      expect(arrivals.get(wise.id)?.quantity).toBe('50');
      expect(arrivals.get(destination.id)?.transferGroupId).toBe(withdrawal?.transferGroupId ?? '');
      expect(arrivals.get(wise.id)?.transferGroupId).toBe(withdrawal?.transferGroupId ?? '');
      // The destination's balance was observed, so the answer does not move it.
      const [after] = await tx
        .select({ balance: schema.holdings.balance })
        .from(schema.holdings)
        .where(eq(schema.holdings.id, destination.id));
      expect(after?.balance).toBe('700');

      expect(await service.undo(user.id, closing.id, tx)).toBe(true);
      const left = await tx
        .select({ id: schema.holdingTransactions.id })
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.userId, user.id));
      expect(left).toEqual([]);
    });
  });

  const REFUSED: ReadonlyArray<
    readonly [string, (d: { accountId: string; id: string }) => object]
  > = [
    [
      'parts that do not add up to the drift',
      (d) => ({
        parts: [
          {
            decision: 'internal',
            quantity: '120',
            destination: { accountId: d.accountId, holdingId: d.id },
          },
          { decision: 'left_control', quantity: '30' },
        ],
      }),
    ],
    [
      'a paired part, which a gap has no deposit for',
      (d) => ({
        parts: [
          { decision: 'paired', quantity: '170', matchTransactionId: crypto.randomUUID() },
          {
            decision: 'internal',
            quantity: '30',
            destination: { accountId: d.accountId, holdingId: d.id },
          },
        ],
      }),
    ],
    [
      'parts beside a whole destination',
      (d) => ({
        editOutflow: {
          decision: 'internal',
          destination: { accountId: d.accountId, holdingId: d.id },
        },
        parts: [
          { decision: 'untracked', quantity: '170' },
          { decision: 'left_control', quantity: '30' },
        ],
      }),
    ],
  ];

  for (const [label, extra] of REFUSED) {
    test(`${label} is refused`, async () => {
      await withTestDb(async (tx) => {
        const { user, destination, closing } = await fixture(tx);
        const service = new BalanceGapService();
        await expect(
          service.answer(
            user.id,
            { observationId: closing.id, answer: 'flow', ...extra(destination) } as never,
            new Date(),
            tx
          )
        ).rejects.toBeInstanceOf(BalanceGapAnswerRejected);
      });
    });
  }
});
