/**
 * SC-1453. A person answered a cash holding's balance gaps before imported
 * trades wrote their settlements; now the same money is booked twice. These
 * run against a real database because the whole question is arithmetic over
 * stored rows, and Retire/Undo are row-for-row claims.
 *
 * The fixture has the three shapes production showed, with synthetic amounts:
 * an answer the settlements explain entirely, one they explain in part, and
 * one they explain neither with nor without the answer.
 */
import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { HoldingBalanceObservationRepository } from '../../../src/repositories/HoldingBalanceObservationRepository';
import { BalanceGapService } from '../../../src/services/holdings/BalanceGapService';
import { SettlementAnswerReviewService } from '../../../src/services/holdings/SettlementAnswerReviewService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

const T0 = new Date('2026-06-01T00:00:00Z');
const T1 = new Date('2026-06-26T00:00:00Z');
const T2 = new Date('2026-07-19T00:00:00Z');
const T3 = new Date('2026-08-18T00:00:00Z');

async function observe(
  tx: DatabaseTransaction,
  userId: string,
  holdingId: string,
  points: Array<[Date, string]>
) {
  return tx
    .insert(schema.holdingBalanceObservations)
    .values(
      points.map(([observedAt, balance]) => ({
        userId,
        holdingId,
        balance,
        observedAt,
        source: 'sync-capture',
      }))
    )
    .returning();
}

async function settlement(
  tx: DatabaseTransaction,
  holding: typeof schema.holdings.$inferSelect,
  kind: 'settle_in' | 'settle_out' | 'fee',
  quantity: string,
  occurredAt: Date,
  trade: string
) {
  await tx.insert(schema.holdingTransactions).values({
    userId: holding.userId,
    holdingId: holding.id,
    tokenId: holding.tokenId,
    kind,
    quantity,
    occurredAt,
    source: 'ibkr-api',
    externalId: `${trade}:${kind === 'fee' ? 'fee' : 'settle'}`,
    sourceMetadata: { settles: trade },
  });
}

async function answerFlow(
  tx: DatabaseTransaction,
  userId: string,
  observationId: string,
  editOutflow?: Parameters<BalanceGapService['answer']>[1]['editOutflow']
) {
  const outcome = await new BalanceGapService().answer(
    userId,
    { observationId, answer: 'flow', ...(editOutflow ? { editOutflow } : {}) },
    new Date('2026-09-01T00:00:00Z'),
    tx
  );
  if (!('result' in outcome)) throw new Error(`answer refused: ${outcome.refusal}`);
}

/**
 * USD cash on one account, three answered intervals, then the settlements the
 * backfill would write. Before the settlements every interval was explained.
 *
 * - (T0, T1]: moved −1000, answered −1000; settlements −990 and a −10 fee.
 * - (T1, T2]: moved −150 with a +600 deposit already there, answered −750;
 *   a −310 settlement. Without the answer: −150 − (600 − 310) = −440.
 * - (T2, T3]: moved −300, answered −300; a +400 settlement from a sale.
 *   Without the answer: −700, more than the answer itself.
 */
async function fixture(tx: DatabaseTransaction, opts: { writeSettlements?: boolean } = {}) {
  const user = await makeUser(tx);
  const usd = await makeToken(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const cash = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: usd.id,
    balance: '18550',
    source: 'ibkr-api',
  });
  await tx.insert(schema.holdingTransactions).values({
    userId: user.id,
    holdingId: cash.id,
    tokenId: usd.id,
    kind: 'deposit',
    quantity: '600',
    occurredAt: new Date('2026-07-10T00:00:00Z'),
    source: 'ibkr-api',
    externalId: 'deposit-1',
  });
  const [, full, partial, unexplained] = await observe(tx, user.id, cash.id, [
    [T0, '20000'],
    [T1, '19000'],
    [T2, '18850'],
    [T3, '18550'],
  ]);
  for (const observation of [full, partial, unexplained])
    await answerFlow(tx, user.id, observation!.id);

  const legs: Array<['settle_in' | 'settle_out' | 'fee', string, Date, string]> = [
    ['settle_out', '-990', new Date('2026-06-20T00:00:00Z'), 'trade-1'],
    ['fee', '-10', new Date('2026-06-20T00:00:00Z'), 'trade-1'],
    ['settle_out', '-310', new Date('2026-07-15T00:00:00Z'), 'trade-2'],
    ['settle_in', '400', new Date('2026-08-10T00:00:00Z'), 'trade-3'],
  ];
  if (opts.writeSettlements ?? true)
    for (const [kind, quantity, at, trade] of legs)
      await settlement(tx, cash, kind, quantity, at, trade);
  const planned = legs.map(([, quantity, occurredAt]) => ({
    holdingId: cash.id,
    occurredAt,
    quantity,
  }));

  return {
    user,
    usd,
    institution,
    cash,
    full: full!,
    partial: partial!,
    unexplained: unexplained!,
    planned,
  };
}

/** A second cash holding whose withdrawal the answer sent to another account. */
async function movedFixture(tx: DatabaseTransaction, opts: { createDestination: boolean }) {
  const user = await makeUser(tx);
  const usd = await makeToken(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const elsewhere = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const cash = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: usd.id,
    balance: '800',
    source: 'ibkr-api',
  });
  const destination = opts.createDestination
    ? null
    : await makeHolding(tx, {
        userId: user.id,
        accountId: elsewhere.id,
        tokenId: usd.id,
        balance: '700',
        source: 'manual',
      });
  const [, closing] = await observe(tx, user.id, cash.id, [
    [T0, '1000'],
    [T1, '800'],
  ]);
  await answerFlow(tx, user.id, closing!.id, {
    decision: 'internal',
    destination: { accountId: elsewhere.id, holdingId: destination?.id ?? null },
    feeQuantity: '5',
  });
  await settlement(tx, cash, 'settle_out', '-200', new Date('2026-06-20T00:00:00Z'), 'trade-9');
  return { user, cash, elsewhere, closing: closing! };
}

/** Every column of every row of this user's ledger, as Postgres renders it. */
async function ledger(tx: DatabaseTransaction, userId: string) {
  const rows = await tx
    .select({ row: sql<Record<string, unknown>>`to_jsonb(${schema.holdingTransactions})` })
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.userId, userId))
    .orderBy(schema.holdingTransactions.id);
  return rows.map(({ row }) => row);
}

async function holdingsOf(tx: DatabaseTransaction, userId: string) {
  const rows = await tx
    .select({ row: sql<Record<string, unknown>>`to_jsonb(${schema.holdings})` })
    .from(schema.holdings)
    .where(eq(schema.holdings.userId, userId))
    .orderBy(schema.holdings.id);
  return rows.map(({ row }) => row);
}

async function observationRow(tx: DatabaseTransaction, id: string) {
  const [row] = await tx
    .select({
      row: sql<Record<string, unknown>>`to_jsonb(${schema.holdingBalanceObservations})`,
    })
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.id, id));
  return row?.row;
}

async function candidateFor(tx: DatabaseTransaction, userId: string, observationId: string) {
  const candidates = await new HoldingBalanceObservationRepository().findGapCandidatesForUser(
    userId,
    tx
  );
  return candidates.find((candidate) => candidate.observationId === observationId);
}

describe('SettlementAnswerReviewService.listPending', () => {
  test('an answer the settlements explain entirely is full, with nothing left over', async () => {
    await withTestDb(async (tx) => {
      const { user, cash, full } = await fixture(tx);
      const [group] = await new SettlementAnswerReviewService().listPending(user.id, tx);
      expect(group?.holdingId).toBe(cash.id);
      const answer = group?.answers.find((item) => item.observationId === full.id);
      expect(answer).toMatchObject({
        explained: 'full',
        amount: '-1000',
        remainder: '0',
        movesAnotherHolding: false,
      });
    });
  });

  test('an answer they explain in part is partial, with the unexplained rest', async () => {
    await withTestDb(async (tx) => {
      const { user, partial } = await fixture(tx);
      const [group] = await new SettlementAnswerReviewService().listPending(user.id, tx);
      const answer = group?.answers.find((item) => item.observationId === partial.id);
      expect(answer).toMatchObject({ explained: 'partial', amount: '-750', remainder: '-440' });
    });
  });

  test('an answer they explain neither with nor without it is not listed', async () => {
    await withTestDb(async (tx) => {
      const { user, full, partial, unexplained } = await fixture(tx);
      // The control: it is a drifting, answered interval with a settlement in
      // it, so only the arithmetic keeps it out.
      expect((await candidateFor(tx, user.id, unexplained.id))?.gapReview).toBe('flow');
      const [group] = await new SettlementAnswerReviewService().listPending(user.id, tx);
      expect(group?.answers.map((item) => item.observationId).sort()).toEqual(
        [full.id, partial.id].sort()
      );
    });
  });

  test('an answer on a holding with no settlements is not listed', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const token = await makeToken(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: (await makeInstitution(tx)).id,
      });
      const cash = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '900',
      });
      const [, closing] = await observe(tx, user.id, cash.id, [
        [T0, '1000'],
        [T1, '900'],
      ]);
      await answerFlow(tx, user.id, closing!.id);
      // A later import that is NOT a settlement makes the interval drift again.
      await tx.insert(schema.holdingTransactions).values({
        userId: user.id,
        holdingId: cash.id,
        tokenId: token.id,
        kind: 'withdraw',
        quantity: '-100',
        occurredAt: new Date('2026-06-20T00:00:00Z'),
        source: 'wise-api',
        externalId: 'w-1',
      });
      expect(await candidateFor(tx, user.id, closing!.id)).toBeDefined();
      expect(await new SettlementAnswerReviewService().listPending(user.id, tx)).toEqual([]);
    });
  });

  test('a kept answer is not listed again', async () => {
    await withTestDb(async (tx) => {
      const { user, full, partial } = await fixture(tx);
      const service = new SettlementAnswerReviewService();
      expect(await service.keep(user.id, full.id, new Date('2026-09-30T00:00:00Z'), tx)).toBe(true);
      const [group] = await service.listPending(user.id, tx);
      expect(group?.answers.map((item) => item.observationId)).toEqual([partial.id]);
      const [observation] = await tx
        .select()
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.id, full.id));
      expect(
        (observation!.sourceMetadata as { gapAnswer: Record<string, unknown> }).gapAnswer
          .keptAfterSettlementsAt
      ).toBe('2026-09-30T00:00:00.000Z');
    });
  });

  test('an answer that sent the money to another holding says so', async () => {
    await withTestDb(async (tx) => {
      const { user, closing } = await movedFixture(tx, { createDestination: false });
      const [group] = await new SettlementAnswerReviewService().listPending(user.id, tx);
      expect(group?.answers).toEqual([
        expect.objectContaining({
          observationId: closing.id,
          explained: 'full',
          amount: '-200',
          movesAnotherHolding: true,
        }),
      ]);
    });
  });
});

describe('SettlementAnswerReviewService.listPendingWith', () => {
  // The backfill's dry run reads this before any leg exists, so it has to
  // reach the listing a written leg would, from nothing but the plan.
  test('a planned settlement is counted as though it were written', async () => {
    await withTestDb(async (tx) => {
      const written = await fixture(tx);
      const whenWritten = await new SettlementAnswerReviewService().listPending(
        written.user.id,
        tx
      );

      const { user, planned } = await fixture(tx, { writeSettlements: false });
      const service = new SettlementAnswerReviewService();
      // The control: with nothing planned there is no settlement to explain
      // anything, so an equal listing below comes from the plan alone.
      expect(await service.listPendingWith(user.id, [], tx)).toEqual([]);
      const [group] = await service.listPendingWith(user.id, planned, tx);
      expect(
        group?.answers.map(({ amount, explained, remainder }) => ({ amount, explained, remainder }))
      ).toEqual(
        whenWritten[0]!.answers.map(({ amount, explained, remainder }) => ({
          amount,
          explained,
          remainder,
        }))
      );
    });
  });
});

/**
 * An answer given as a balance edit before answers kept a receipt: the
 * observation carries only `gapReview`, and its row is linked by the external id
 * the edit stamped from the observation's own time. Every answer in production
 * has this shape. `externalAt` lets the control break that link.
 */
async function legacyFixture(tx: DatabaseTransaction, externalAt: Date = T1) {
  const user = await makeUser(tx);
  const usd = await makeToken(tx);
  const account = await makeAccount(tx, {
    userId: user.id,
    institutionId: (await makeInstitution(tx)).id,
  });
  const cash = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: usd.id,
    balance: '19000',
    source: 'ibkr-api',
  });
  const [, closing] = await observe(tx, user.id, cash.id, [
    [T0, '20000'],
    [T1, '19000'],
  ]);
  await tx
    .update(schema.holdingBalanceObservations)
    .set({ gapReview: 'flow', gapReviewSource: 'user', gapReviewedAt: T1 })
    .where(eq(schema.holdingBalanceObservations.id, closing!.id));
  await tx.insert(schema.holdingTransactions).values({
    userId: user.id,
    holdingId: cash.id,
    tokenId: usd.id,
    kind: 'withdraw',
    quantity: '-1000',
    occurredAt: new Date('2026-06-25T00:00:00Z'),
    source: 'user-balance-edit',
    externalId: `manual-edit:${externalAt.toISOString()}`,
    sourceMetadata: { cause: 'flow' },
  });
  await settlement(tx, cash, 'settle_out', '-990', new Date('2026-06-20T00:00:00Z'), 'trade-1');
  await settlement(tx, cash, 'fee', '-10', new Date('2026-06-20T00:00:00Z'), 'trade-1');
  return { user, cash, closing: closing! };
}

describe('SettlementAnswerReviewService — an answer given as a balance edit', () => {
  test('is listed, retired and put back through the row its edit stamped', async () => {
    await withTestDb(async (tx) => {
      const { user, cash, closing } = await legacyFixture(tx);
      const service = new SettlementAnswerReviewService();
      const [group] = await service.listPending(user.id, tx);
      expect(group?.answers).toEqual([
        expect.objectContaining({
          observationId: closing.id,
          explained: 'full',
          amount: '-1000',
          remainder: '0',
        }),
      ]);

      const before = await ledger(tx, user.id);
      const outcome = await service.retire(user.id, closing.id, {}, tx);
      if (!('retired' in outcome)) throw new Error(`refused: ${outcome.refusal}`);
      expect(
        (await ledger(tx, user.id)).filter((row) => row.source === 'user-balance-edit')
      ).toEqual([]);
      expect((await observationRow(tx, closing.id))?.gap_review).toBeNull();

      expect(await service.undoRetire(user.id, outcome.retired.id, T3, tx)).toEqual({
        restored: { rows: 1, observation: 'restamped' },
      });
      expect(await ledger(tx, user.id)).toEqual(before);
      expect(cash.id).toBe(group!.holdingId);
    });
  });

  test('is not listed when no row carries the external id its observation implies', async () => {
    await withTestDb(async (tx) => {
      // The control: the same answer, amounts and settlements, with only the
      // link broken. Listing it would mean the review matched on something else.
      const { user } = await legacyFixture(tx, new Date('2026-06-26T00:00:01Z'));
      expect(await new SettlementAnswerReviewService().listPending(user.id, tx)).toEqual([]);
    });
  });
});

describe('SettlementAnswerReviewService.retire', () => {
  test('a full answer leaves the ledger, the interval stops drifting, and the copy is whole', async () => {
    await withTestDb(async (tx) => {
      const { user, full } = await fixture(tx);
      const before = await ledger(tx, user.id);
      const service = new SettlementAnswerReviewService();
      const outcome = await service.retire(user.id, full.id, {}, tx);
      expect(outcome).toMatchObject({ retired: { explained: 'full', remainder: '0' } });
      if (!('retired' in outcome)) throw new Error('not retired');

      const after = await ledger(tx, user.id);
      const [retired] = await tx
        .select()
        .from(schema.retiredGapAnswers)
        .where(eq(schema.retiredGapAnswers.id, outcome.retired.id));
      const removed = retired?.rows as Record<string, unknown>[];
      expect(removed.map((row) => row.quantity)).toEqual(['-1000']);
      expect(after).toHaveLength(before.length - 1);
      expect(before).toContainEqual(removed[0]!);
      expect(retired?.restoredAt).toBeNull();

      expect(await candidateFor(tx, user.id, full.id)).toBeUndefined();
      const [observation] = await tx
        .select()
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.id, full.id));
      expect(observation?.gapReview).toBeNull();
    });
  });

  test('a partial answer leaves its remainder as an ordinary balance gap', async () => {
    await withTestDb(async (tx) => {
      const { user, partial } = await fixture(tx);
      const outcome = await new SettlementAnswerReviewService().retire(user.id, partial.id, {}, tx);
      expect(outcome).toMatchObject({ retired: { explained: 'partial', remainder: '-440' } });
      const candidate = await candidateFor(tx, user.id, partial.id);
      expect(candidate?.gapReview).toBeNull();
      expect(
        Number(candidate!.balance) -
          Number(candidate!.previousBalance) -
          Number(candidate!.explained)
      ).toBe(-440);
    });
  });

  test('an answer the settlements do not explain is refused', async () => {
    await withTestDb(async (tx) => {
      const { user, unexplained } = await fixture(tx);
      const before = await ledger(tx, user.id);
      expect(
        await new SettlementAnswerReviewService().retire(user.id, unexplained.id, {}, tx)
      ).toEqual({ refusal: 'not-redundant' });
      expect(await ledger(tx, user.id)).toEqual(before);
    });
  });

  test('an answer that moved another holding needs a second confirmation', async () => {
    await withTestDb(async (tx) => {
      const { user, closing } = await movedFixture(tx, { createDestination: false });
      const before = await ledger(tx, user.id);
      const service = new SettlementAnswerReviewService();
      expect(await service.retire(user.id, closing.id, {}, tx)).toEqual({
        refusal: 'moves-another-holding',
      });
      expect(await ledger(tx, user.id)).toEqual(before);

      const outcome = await service.retire(user.id, closing.id, { confirmOtherHolding: true }, tx);
      expect(outcome).toHaveProperty('retired');
      const left = await ledger(tx, user.id);
      // The withdrawal, its fee and the arrival on the other account are gone;
      // only the settlement stays.
      expect(left.map((row) => row.kind)).toEqual(['settle_out']);
    });
  });
});

describe('SettlementAnswerReviewService.undoRetire', () => {
  test('puts every row back byte for byte, the arrival on another holding included', async () => {
    await withTestDb(async (tx) => {
      const { user, closing } = await movedFixture(tx, { createDestination: false });
      const ledgerBefore = await ledger(tx, user.id);
      const observationBefore = await observationRow(tx, closing.id);
      expect(ledgerBefore.some((row) => row.source === 'transfer-review')).toBe(true);

      const service = new SettlementAnswerReviewService();
      const outcome = await service.retire(user.id, closing.id, { confirmOtherHolding: true }, tx);
      if (!('retired' in outcome)) throw new Error('not retired');
      expect(await ledger(tx, user.id)).not.toEqual(ledgerBefore);

      expect(await service.undoRetire(user.id, outcome.retired.id, new Date(), tx)).toEqual({
        restored: { rows: 3, observation: 'restamped' },
      });
      expect(await ledger(tx, user.id)).toEqual(ledgerBefore);
      expect(await observationRow(tx, closing.id)).toEqual(observationBefore);
      expect(await service.undoRetire(user.id, outcome.retired.id, new Date(), tx)).toEqual({
        refusal: 'already-restored',
      });
    });
  });

  test('a destination holding the answer had opened comes back with its arrival', async () => {
    await withTestDb(async (tx) => {
      const { user, closing } = await movedFixture(tx, { createDestination: true });
      const ledgerBefore = await ledger(tx, user.id);
      const holdingsBefore = await holdingsOf(tx, user.id);
      expect(holdingsBefore).toHaveLength(2);

      const service = new SettlementAnswerReviewService();
      const outcome = await service.retire(user.id, closing.id, { confirmOtherHolding: true }, tx);
      if (!('retired' in outcome)) throw new Error('not retired');
      // The reopen deletes a holding the answer opened and nothing else touched.
      expect(await holdingsOf(tx, user.id)).toHaveLength(1);

      expect(await service.undoRetire(user.id, outcome.retired.id, new Date(), tx)).toHaveProperty(
        'restored'
      );
      expect(await holdingsOf(tx, user.id)).toEqual(holdingsBefore);
      expect(await ledger(tx, user.id)).toEqual(ledgerBefore);
    });
  });

  test('restores the rows when the observation has since been deleted, and says so', async () => {
    await withTestDb(async (tx) => {
      const { user, full } = await fixture(tx);
      const before = await ledger(tx, user.id);
      const service = new SettlementAnswerReviewService();
      const outcome = await service.retire(user.id, full.id, {}, tx);
      if (!('retired' in outcome)) throw new Error('not retired');
      await tx
        .delete(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.id, full.id));

      expect(await service.undoRetire(user.id, outcome.retired.id, new Date(), tx)).toEqual({
        restored: { rows: 1, observation: 'gone' },
      });
      expect(await ledger(tx, user.id)).toEqual(before);
    });
  });

  test('restamps the answer when its receipt was rewritten since, and says so', async () => {
    await withTestDb(async (tx) => {
      const { user, partial } = await fixture(tx);
      const before = await ledger(tx, user.id);
      const service = new SettlementAnswerReviewService();
      const outcome = await service.retire(user.id, partial.id, {}, tx);
      if (!('retired' in outcome)) throw new Error('not retired');
      // The remainder answered and then undone rewrites the observation's metadata.
      await answerFlow(tx, user.id, partial.id);
      expect(await new BalanceGapService().undo(user.id, partial.id, tx)).toBe(true);

      expect(await service.undoRetire(user.id, outcome.retired.id, new Date(), tx)).toEqual({
        restored: { rows: 1, observation: 'rewritten' },
      });
      expect(await ledger(tx, user.id)).toEqual(before);
      expect((await candidateFor(tx, user.id, partial.id))?.gapReview).toBe('flow');
    });
  });

  test('refuses while the remainder is answered, rather than booking the interval twice', async () => {
    await withTestDb(async (tx) => {
      const { user, partial } = await fixture(tx);
      const service = new SettlementAnswerReviewService();
      const outcome = await service.retire(user.id, partial.id, {}, tx);
      if (!('retired' in outcome)) throw new Error('not retired');
      await answerFlow(tx, user.id, partial.id);
      const answered = await ledger(tx, user.id);

      expect(await service.undoRetire(user.id, outcome.retired.id, new Date(), tx)).toEqual({
        refusal: 'answered-since',
      });
      expect(await ledger(tx, user.id)).toEqual(answered);
      const [retired] = await tx
        .select()
        .from(schema.retiredGapAnswers)
        .where(
          and(
            eq(schema.retiredGapAnswers.userId, user.id),
            inArray(schema.retiredGapAnswers.id, [outcome.retired.id])
          )
        );
      expect(retired?.restoredAt).toBeNull();
    });
  });
});
