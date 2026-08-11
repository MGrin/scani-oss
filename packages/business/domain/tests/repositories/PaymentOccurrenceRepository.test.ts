import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { PaymentOccurrenceRepository } from '../../src/repositories/PaymentOccurrenceRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { makePayment, makePaymentOccurrence } from '../../test/helpers/factories-extra';

const repo = () => Container.get(PaymentOccurrenceRepository);

describe('PaymentOccurrenceRepository', () => {
  describe('bulkUpsert', () => {
    test('inserts rows and skips duplicates on (payment_id, due_date) rather than throwing', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id });

        await repo().bulkUpsert(
          [
            { paymentId: payment.id, dueDate: '2026-03-01', expectedAmount: '12.99' },
            { paymentId: payment.id, dueDate: '2026-04-01', expectedAmount: '12.99' },
          ],
          tx
        );
        // Re-run with an overlapping row plus one new one — the overlap
        // must be silently skipped, not throw on the unique constraint.
        await repo().bulkUpsert(
          [
            { paymentId: payment.id, dueDate: '2026-04-01', expectedAmount: '99.99' },
            { paymentId: payment.id, dueDate: '2026-05-01', expectedAmount: '12.99' },
          ],
          tx
        );

        const rows = await repo().findByPaymentId(payment.id, tx);
        expect(rows.map((r) => r.dueDate)).toEqual(['2026-03-01', '2026-04-01', '2026-05-01']);
        // Conflict was skipped, not updated — original amount survives.
        expect(rows.find((r) => r.dueDate === '2026-04-01')?.expectedAmount).toBe('12.99');
      });
    });

    test('empty input is a no-op', async () => {
      await withTestDb(async (tx) => {
        expect(await repo().bulkUpsert([], tx)).toEqual([]);
      });
    });
  });

  describe('updateFutureScheduledAmount', () => {
    test('updates only scheduled occurrences due on or after the given date', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id });
        const past = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: '2026-01-01',
          status: 'scheduled',
          expectedAmount: '12.99',
        });
        const future = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: '2026-06-01',
          status: 'scheduled',
          expectedAmount: '12.99',
        });
        const matchedFuture = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: '2026-07-01',
          status: 'matched',
          expectedAmount: '12.99',
          actualAmount: '12.99',
        });

        await repo().updateFutureScheduledAmount(payment.id, '2026-03-01', '14.99', tx);

        const rows = await repo().findByPaymentId(payment.id, tx);
        expect(rows.find((r) => r.id === past.id)?.expectedAmount).toBe('12.99');
        expect(rows.find((r) => r.id === future.id)?.expectedAmount).toBe('14.99');
        // matched status excludes it even though its due date is future.
        expect(rows.find((r) => r.id === matchedFuture.id)?.expectedAmount).toBe('12.99');
      });
    });
  });

  describe('deleteScheduledOnOrAfter', () => {
    test('removes only scheduled occurrences on or after the given date', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id });
        const past = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: '2026-01-01',
          status: 'scheduled',
        });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: '2026-06-01',
          status: 'scheduled',
        });
        const matchedFuture = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: '2026-07-01',
          status: 'matched',
          actualAmount: '12.99',
        });

        await repo().deleteScheduledOnOrAfter(payment.id, '2026-03-01', tx);

        const rows = await repo().findByPaymentId(payment.id, tx);
        expect(rows.map((r) => r.id).sort()).toEqual([past.id, matchedFuture.id].sort());
      });
    });
  });
});
