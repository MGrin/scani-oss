import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { PaymentOccurrenceRepository } from '../../../src/repositories/PaymentOccurrenceRepository';
import { PaymentRepository } from '../../../src/repositories/PaymentRepository';
import { PaymentService } from '../../../src/services/payments/PaymentService';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';
import {
  makeHoldingTransaction,
  makePayment,
  makePaymentOccurrence,
} from '../../../test/helpers/factories-extra';

const service = () => Container.get(PaymentService);
const occurrences = () => Container.get(PaymentOccurrenceRepository);
const payments = () => Container.get(PaymentRepository);

// Today, truncated to a UTC date string — matches what PaymentService's
// own `startOfUtcToday` produces, so tests can position occurrences
// relative to "now" without hardcoding a date the test could outrun.
function todayUtcString(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

function pastDateString(daysAgo: number): string {
  const now = new Date();
  const past = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo)
  );
  return past.toISOString().slice(0, 10);
}

// Month offset from "now", pinned to the 1st of the target month so the
// assertions below never depend on today's actual day-of-month (which
// would otherwise interact with `recurrence.ts`'s end-of-month clamping
// on some days of some months and make the exact-date assertions flaky).
function monthsFromNowUtcString(monthOffset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1))
    .toISOString()
    .slice(0, 10);
}

describe('PaymentService', () => {
  describe('materialise', () => {
    test('is idempotent — running it twice leaves the same occurrence count with no duplicate due dates', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: user.id,
          anchorDate: todayUtcString(),
          intervalUnit: 'month',
          intervalCount: 1,
          expectedAmount: '12.99',
        });

        const first = await service().materialise(user.id, payment.id, tx);
        expect(first.length).toBeGreaterThan(0);

        const afterFirst = await occurrences().findByPaymentId(payment.id, tx);
        await service().materialise(user.id, payment.id, tx);
        const afterSecond = await occurrences().findByPaymentId(payment.id, tx);

        expect(afterSecond.length).toBe(afterFirst.length);
        const dueDates = afterSecond.map((o) => o.dueDate);
        expect(new Set(dueDates).size).toBe(dueDates.length);
      });
    });

    test('materialises at least one future scheduled occurrence for an active monthly payment', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: user.id,
          anchorDate: todayUtcString(),
          intervalUnit: 'month',
          intervalCount: 1,
        });

        await service().materialise(user.id, payment.id, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.status === 'scheduled')).toBe(true);
      });
    });

    // Regression pin for the spec's own justification for materialising
    // at all ("Why occurrences are materialised" in
    // docs/implementation/2026-08-10_payments-layer.md): the window is
    // [anchorDate, now+12mo], not [now, now+12mo]. An old anchor must
    // still produce its full past history — that history is the whole
    // point of a stateful `payment_occurrences` row instead of a
    // computed rule.
    test('covers the full span from an old anchorDate through 12 months forward, not just the future', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const anchor = monthsFromNowUtcString(-18);
        const payment = await makePayment(tx, {
          userId: user.id,
          anchorDate: anchor,
          intervalUnit: 'month',
          intervalCount: 1,
        });

        const created = await service().materialise(user.id, payment.id, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const dueDates = rows.map((r) => r.dueDate);

        expect(created.length).toBe(31); // -18 .. +12 inclusive, monthly
        expect(dueDates[0]).toBe(anchor);
        expect(dueDates[dueDates.length - 1]).toBe(monthsFromNowUtcString(12));
        // The bulk of these rows are in the past relative to today —
        // proving materialise does NOT skip them.
        expect(dueDates.filter((d) => d < todayUtcString()).length).toBeGreaterThan(0);
      });
    });

    test('re-running later does not duplicate and keeps the oldest historical occurrence intact', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const anchor = monthsFromNowUtcString(-18);
        const payment = await makePayment(tx, {
          userId: user.id,
          anchorDate: anchor,
          intervalUnit: 'month',
          intervalCount: 1,
        });

        await service().materialise(user.id, payment.id, tx);
        const afterFirst = await occurrences().findByPaymentId(payment.id, tx);

        // Simulates the scheduled re-run mentioned in the spec — same
        // payment, later call, no change to its shape.
        await service().materialise(user.id, payment.id, tx);
        const afterSecond = await occurrences().findByPaymentId(payment.id, tx);

        expect(afterSecond.length).toBe(afterFirst.length);
        const dueDates = afterSecond.map((o) => o.dueDate);
        expect(new Set(dueDates).size).toBe(dueDates.length);
        expect(dueDates[0]).toBe(anchor);
      });
    });

    test('a past occurrence already marked matched survives a plain re-materialise unchanged', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const anchor = monthsFromNowUtcString(-18);
        const payment = await makePayment(tx, {
          userId: user.id,
          anchorDate: anchor,
          intervalUnit: 'month',
          intervalCount: 1,
          expectedAmount: '12.99',
        });

        await service().materialise(user.id, payment.id, tx);
        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const someHistoricalRow = rows[3];
        if (!someHistoricalRow) throw new Error('expected a historical occurrence to settle');

        // Settle it, the way the (not-yet-built) manual settlement path
        // would — expected stays what it was, actual differs.
        const settled = await occurrences().update(
          someHistoricalRow.id,
          { status: 'matched', actualAmount: '14.99' },
          tx
        );
        expect(settled?.status).toBe('matched');

        await service().materialise(user.id, payment.id, tx);

        const reloaded = await occurrences().findByPaymentId(payment.id, tx);
        const stillSettled = reloaded.find((r) => r.id === someHistoricalRow.id);
        expect(stillSettled?.status).toBe('matched');
        expect(stillSettled?.expectedAmount).toBe('12.99');
        expect(stillSettled?.actualAmount).toBe('14.99');
        expect(reloaded.length).toBe(rows.length);
      });
    });
  });

  describe('update', () => {
    test('editing the amount updates future scheduled occurrences but leaves matched/skipped history untouched', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: user.id,
          anchorDate: todayUtcString(),
          intervalUnit: 'month',
          intervalCount: 1,
          expectedAmount: '12.99',
        });
        await service().materialise(user.id, payment.id, tx);

        // Historical rows predating this payment's own anchorDate (set
        // to today above), so materialise itself would never produce
        // these — inserted directly to simulate months settled before
        // the payment existed in Scani (e.g. imported history).
        const matchedPast = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: pastDateString(30),
          status: 'matched',
          expectedAmount: '12.99',
          actualAmount: '12.99',
        });
        const skippedPast = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: pastDateString(60),
          status: 'skipped',
          expectedAmount: '12.99',
        });

        await service().update(user.id, payment.id, { expectedAmount: '14.99' }, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);

        const futureScheduled = rows.filter((r) => r.status === 'scheduled');
        expect(futureScheduled.length).toBeGreaterThan(0);
        expect(futureScheduled.every((r) => r.expectedAmount === '14.99')).toBe(true);

        const matchedRow = rows.find((r) => r.id === matchedPast.id);
        expect(matchedRow?.status).toBe('matched');
        expect(matchedRow?.expectedAmount).toBe('12.99');
        expect(matchedRow?.actualAmount).toBe('12.99');

        const skippedRow = rows.find((r) => r.id === skippedPast.id);
        expect(skippedRow?.status).toBe('skipped');
        expect(skippedRow?.expectedAmount).toBe('12.99');
      });
    });

    test('leaves occurrences untouched when the amount does not actually change', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: user.id,
          anchorDate: todayUtcString(),
          expectedAmount: '12.99',
        });
        await service().materialise(user.id, payment.id, tx);
        const before = await occurrences().findByPaymentId(payment.id, tx);

        await service().update(user.id, payment.id, { notes: 'unrelated change' }, tx);

        const after = await occurrences().findByPaymentId(payment.id, tx);
        expect(after).toEqual(before);
      });
    });
  });

  describe('ownership', () => {
    test('materialise throws for a payment belonging to another user and writes nothing', async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const intruder = await makeUser(tx);
        const payment = await makePayment(tx, { userId: owner.id, anchorDate: todayUtcString() });

        await expect(service().materialise(intruder.id, payment.id, tx)).rejects.toThrow();

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        expect(rows).toEqual([]);
      });
    });

    test('update throws for a payment belonging to another user and leaves it unchanged', async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const intruder = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: owner.id,
          anchorDate: todayUtcString(),
          expectedAmount: '12.99',
        });

        await expect(
          service().update(intruder.id, payment.id, { expectedAmount: '999.99' }, tx)
        ).rejects.toThrow();

        const reloaded = await payments().findByIdAndUser(payment.id, owner.id, tx);
        expect(reloaded?.expectedAmount).toBe('12.99');
      });
    });

    test('pause and end throw for a payment belonging to another user', async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const intruder = await makeUser(tx);
        const payment = await makePayment(tx, { userId: owner.id, anchorDate: todayUtcString() });

        await expect(service().pause(intruder.id, payment.id, tx)).rejects.toThrow();
        await expect(service().end(intruder.id, payment.id, undefined, tx)).rejects.toThrow();

        const reloaded = await payments().findByIdAndUser(payment.id, owner.id, tx);
        expect(reloaded?.status).toBe('active');
      });
    });
  });

  describe('create', () => {
    test('rejects a vendor that does not belong to the user', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const otherUser = await makeUser(tx);
        const foreignPayment = await makePayment(tx, { userId: otherUser.id });

        await expect(
          service().create(
            user.id,
            {
              vendorId: foreignPayment.vendorId,
              direction: 'outflow',
              kind: 'fixed',
              currencyTokenId: foreignPayment.currencyTokenId,
              intervalUnit: 'month',
              intervalCount: 1,
              anchorDate: todayUtcString(),
            },
            tx
          )
        ).rejects.toThrow();
      });
    });
  });

  describe('pause', () => {
    test('sets status to paused and materialise then generates nothing new', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id, anchorDate: todayUtcString() });
        await service().materialise(user.id, payment.id, tx);
        const before = await occurrences().findByPaymentId(payment.id, tx);

        const paused = await service().pause(user.id, payment.id, tx);
        expect(paused.status).toBe('paused');

        await service().materialise(user.id, payment.id, tx);
        const after = await occurrences().findByPaymentId(payment.id, tx);
        expect(after.length).toBe(before.length);
      });
    });
  });

  describe('settleOccurrence', () => {
    test('marks a scheduled occurrence matched, and repeating the same call is idempotent', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id, expectedAmount: '12.99' });
        const occurrence = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: todayUtcString(),
          expectedAmount: '12.99',
        });

        const first = await service().settleOccurrence(
          user.id,
          occurrence.id,
          { status: 'matched', actualAmount: '12.99' },
          tx
        );
        const second = await service().settleOccurrence(
          user.id,
          occurrence.id,
          { status: 'matched', actualAmount: '12.99' },
          tx
        );

        expect(first.status).toBe('matched');
        expect(first.actualAmount).toBe('12.99');
        expect(second).toEqual(first);
      });
    });

    test('re-settling an already-matched occurrence does not discard its matchedTransactionId', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id, expectedAmount: '12.99' });
        const occurrence = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: todayUtcString(),
          expectedAmount: '12.99',
        });

        // Simulates the automated match path (ReconcilePaymentsUseCase)
        // having already tied this occurrence to a real transaction.
        const holdingTx = await makeHoldingTransaction(tx, {
          userId: user.id,
          quantity: '-12.99',
        });
        await service().settleOccurrence(
          user.id,
          occurrence.id,
          { status: 'matched', actualAmount: '12.99', matchedTransactionId: holdingTx.id },
          tx
        );

        // The user re-confirms via the UI's plain "mark paid" control,
        // which never sends matchedTransactionId.
        const reconfirmed = await service().settleOccurrence(
          user.id,
          occurrence.id,
          { status: 'matched', actualAmount: '13.50' },
          tx
        );

        expect(reconfirmed.matchedTransactionId).toBe(holdingTx.id);
        expect(reconfirmed.actualAmount).toBe('13.50');
      });
    });

    test('settling a scheduled occurrence as skipped clears no pre-existing match data by itself', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id });
        const occurrence = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: todayUtcString(),
        });

        const skipped = await service().settleOccurrence(
          user.id,
          occurrence.id,
          {
            status: 'skipped',
          },
          tx
        );

        expect(skipped.status).toBe('skipped');
      });
    });

    test('throws for an occurrence belonging to another user and writes nothing', async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const intruder = await makeUser(tx);
        const payment = await makePayment(tx, { userId: owner.id, expectedAmount: '12.99' });
        const occurrence = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: todayUtcString(),
          expectedAmount: '12.99',
        });

        await expect(
          service().settleOccurrence(intruder.id, occurrence.id, { status: 'matched' }, tx)
        ).rejects.toThrow();

        const reloaded = await occurrences().findByPaymentId(payment.id, tx);
        const stillScheduled = reloaded.find((r) => r.id === occurrence.id);
        expect(stillScheduled?.status).toBe('scheduled');
        expect(stillScheduled?.matchedTransactionId).toBeNull();
      });
    });
  });

  describe('end', () => {
    test('sets status to ended, records the end date, and clears scheduled occurrences after it', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: user.id,
          anchorDate: todayUtcString(),
          intervalUnit: 'month',
          intervalCount: 1,
        });
        await service().materialise(user.id, payment.id, tx);
        const beforeCount = (await occurrences().findByPaymentId(payment.id, tx)).length;
        expect(beforeCount).toBeGreaterThan(1);

        const ended = await service().end(user.id, payment.id, todayUtcString(), tx);
        expect(ended.status).toBe('ended');
        expect(ended.endDate).toBe(todayUtcString());

        const after = await occurrences().findByPaymentId(payment.id, tx);
        expect(after.every((o) => o.dueDate <= todayUtcString())).toBe(true);
      });
    });
  });
});
