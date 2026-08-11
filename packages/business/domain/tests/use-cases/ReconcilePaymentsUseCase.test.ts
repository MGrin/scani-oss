import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { PaymentOccurrenceRepository } from '../../src/repositories/PaymentOccurrenceRepository';
import { ReconcilePaymentsUseCase } from '../../src/use-cases/ReconcilePaymentsUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHoldingTransaction,
  makePayment,
  makePaymentOccurrence,
} from '../../test/helpers/factories-extra';

const useCase = () => Container.get(ReconcilePaymentsUseCase);
const occurrences = () => Container.get(PaymentOccurrenceRepository);

describe('ReconcilePaymentsUseCase', () => {
  test('throws when called without a userId', async () => {
    await expect(useCase().execute('')).rejects.toThrow(/requires userId/);
  });

  test('auto-matches a scheduled occurrence to an exact same-amount, same-day transaction on the linked account', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: (await makeInstitution(tx)).id,
      });
      const payment = await makePayment(tx, {
        userId: user.id,
        accountId: account.id,
        direction: 'outflow',
        expectedAmount: '50.00',
      });
      await makePaymentOccurrence(tx, {
        paymentId: payment.id,
        dueDate: '2026-03-05',
        expectedAmount: '50.00',
      });
      const holdingTx = await makeHoldingTransaction(tx, {
        userId: user.id,
        accountId: account.id,
        quantity: '-50.00',
        occurredAt: new Date('2026-03-05T12:00:00.000Z'),
      });

      const summary = await useCase().execute(user.id, {}, tx);
      expect(summary.scanned).toBe(1);
      expect(summary.matched).toBe(1);

      const [reloaded] = await occurrences().findByPaymentId(payment.id, tx);
      expect(reloaded?.status).toBe('matched');
      expect(reloaded?.matchedTransactionId).toBe(holdingTx.id);
      expect(reloaded?.actualAmount).toBe('50');
    });
  });

  test('skips payments with no linked account — nothing to match against', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const payment = await makePayment(tx, {
        userId: user.id,
        accountId: null,
        expectedAmount: '50.00',
      });
      await makePaymentOccurrence(tx, {
        paymentId: payment.id,
        dueDate: '2026-03-05',
        expectedAmount: '50.00',
      });

      const summary = await useCase().execute(user.id, {}, tx);
      expect(summary.scanned).toBe(0);
      expect(summary.matched).toBe(0);
    });
  });

  test('two equally-good candidate transactions leave the occurrence scheduled — ambiguity is not guessed', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: (await makeInstitution(tx)).id,
      });
      const payment = await makePayment(tx, {
        userId: user.id,
        accountId: account.id,
        direction: 'outflow',
        expectedAmount: '50.00',
      });
      await makePaymentOccurrence(tx, {
        paymentId: payment.id,
        dueDate: '2026-03-05',
        expectedAmount: '50.00',
      });
      await makeHoldingTransaction(tx, {
        userId: user.id,
        accountId: account.id,
        quantity: '-50.00',
        occurredAt: new Date('2026-03-04T00:00:00.000Z'),
      });
      await makeHoldingTransaction(tx, {
        userId: user.id,
        accountId: account.id,
        quantity: '-50.00',
        occurredAt: new Date('2026-03-06T00:00:00.000Z'),
      });

      const summary = await useCase().execute(user.id, {}, tx);
      expect(summary.scanned).toBe(1);
      expect(summary.matched).toBe(0);

      const [reloaded] = await occurrences().findByPaymentId(payment.id, tx);
      expect(reloaded?.status).toBe('scheduled');
      expect(reloaded?.matchedTransactionId).toBeNull();
    });
  });

  test('re-running is idempotent — an already-matched occurrence is not rescanned', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: (await makeInstitution(tx)).id,
      });
      const payment = await makePayment(tx, {
        userId: user.id,
        accountId: account.id,
        direction: 'outflow',
        expectedAmount: '50.00',
      });
      await makePaymentOccurrence(tx, {
        paymentId: payment.id,
        dueDate: '2026-03-05',
        expectedAmount: '50.00',
      });
      const holdingTx = await makeHoldingTransaction(tx, {
        userId: user.id,
        accountId: account.id,
        quantity: '-50.00',
        occurredAt: new Date('2026-03-05T12:00:00.000Z'),
      });

      const first = await useCase().execute(user.id, {}, tx);
      expect(first.matched).toBe(1);

      const second = await useCase().execute(user.id, {}, tx);
      expect(second.scanned).toBe(0);
      expect(second.matched).toBe(0);

      const [reloaded] = await occurrences().findByPaymentId(payment.id, tx);
      expect(reloaded?.matchedTransactionId).toBe(holdingTx.id);
    });
  });
});
