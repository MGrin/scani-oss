import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { PaymentOccurrenceRepository } from '../../src/repositories/PaymentOccurrenceRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { makePayment, makePaymentOccurrence, makeToken } from '../../test/helpers/factories-extra';

/**
 * `findDueOnDateForUser` — the query the payment reminder is built on (SC-226).
 *
 * Every filter in it changes what the notification SAYS, and getting one wrong
 * produces a notification that is confidently incorrect rather than absent:
 * a bill already paid this morning, someone else's rent, or a salary netted
 * against the total. None of that is visible from the pure summariser's tests,
 * because by then the rows have already been chosen.
 */

const repo = () => Container.get(PaymentOccurrenceRepository);

const TOMORROW = '2026-08-17';
const TODAY = '2026-08-16';

describe('PaymentOccurrenceRepository.findDueOnDateForUser', () => {
  test('returns the scheduled outflows due on exactly that date', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      // The factory's own generated symbol, not a real one: the seeded token
      // table already holds EUR, and a fixed symbol here collides with it.
      const token = await makeToken(tx);
      const payment = await makePayment(tx, {
        userId: user.id,
        currencyTokenId: token.id,
        expectedAmount: '80.00',
      });
      await makePaymentOccurrence(tx, {
        paymentId: payment.id,
        dueDate: TOMORROW,
        status: 'scheduled',
        expectedAmount: '99.50',
      });

      const rows = await repo().findDueOnDateForUser(user.id, TOMORROW, tx);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.dueDate).toBe(TOMORROW);
      expect(rows[0]?.expectedAmount).toBe('99.50');
      // The join carries the SYMBOL, not just the id — that is what the
      // notification body renders in front of the total.
      expect(rows[0]?.currencySymbol).toBe(token.symbol);
      expect(rows[0]?.currencyTokenId).toBe(token.id);
    });
  });

  test('falls back to the payment`s amount when the occurrence has none', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const payment = await makePayment(tx, { userId: user.id, expectedAmount: '42.00' });
      await makePaymentOccurrence(tx, {
        paymentId: payment.id,
        dueDate: TOMORROW,
        status: 'scheduled',
        expectedAmount: null,
      });

      const rows = await repo().findDueOnDateForUser(user.id, TOMORROW, tx);

      expect(rows[0]?.expectedAmount).toBe('42.00');
    });
  });

  test('a variable payment with no estimate anywhere comes back null, not zero', async () => {
    // The summariser COUNTS these and never sums them. A zero here would be a
    // number nobody entered, quietly folded into the total.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const payment = await makePayment(tx, {
        userId: user.id,
        kind: 'variable',
        expectedAmount: null,
      });
      await makePaymentOccurrence(tx, {
        paymentId: payment.id,
        dueDate: TOMORROW,
        status: 'scheduled',
        expectedAmount: null,
      });

      const rows = await repo().findDueOnDateForUser(user.id, TOMORROW, tx);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.expectedAmount).toBeNull();
    });
  });

  test('excludes INFLOWS — expected income is not a bill to pay', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const salary = await makePayment(tx, { userId: user.id, direction: 'inflow' });
      await makePaymentOccurrence(tx, {
        paymentId: salary.id,
        dueDate: TOMORROW,
        status: 'scheduled',
        expectedAmount: '3000.00',
      });

      expect(await repo().findDueOnDateForUser(user.id, TOMORROW, tx)).toEqual([]);
    });
  });

  test('excludes occurrences that are already settled', async () => {
    // Reminding someone to pay a bill they paid this morning is how a
    // reminder loses the authority it needs to be worth reading.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const payment = await makePayment(tx, { userId: user.id });
      for (const status of ['matched', 'skipped', 'missed'] as const) {
        const other = await makePayment(tx, { userId: user.id });
        await makePaymentOccurrence(tx, {
          paymentId: other.id,
          dueDate: TOMORROW,
          status,
          expectedAmount: '10.00',
        });
      }
      await makePaymentOccurrence(tx, {
        paymentId: payment.id,
        dueDate: TOMORROW,
        status: 'scheduled',
        expectedAmount: '10.00',
      });

      const rows = await repo().findDueOnDateForUser(user.id, TOMORROW, tx);

      expect(rows).toHaveLength(1);
    });
  });

  test('excludes paused and ended payments, which keep their future rows', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      for (const status of ['paused', 'ended'] as const) {
        const payment = await makePayment(tx, { userId: user.id, status });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: TOMORROW,
          status: 'scheduled',
          expectedAmount: '10.00',
        });
      }

      expect(await repo().findDueOnDateForUser(user.id, TOMORROW, tx)).toEqual([]);
    });
  });

  test('matches the date exactly — today`s overdue rows are a different notification', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const payment = await makePayment(tx, { userId: user.id });
      await makePaymentOccurrence(tx, {
        paymentId: payment.id,
        dueDate: TODAY,
        status: 'scheduled',
        expectedAmount: '10.00',
      });

      expect(await repo().findDueOnDateForUser(user.id, TOMORROW, tx)).toEqual([]);
    });
  });

  test('never returns another user`s payments', async () => {
    await withTestDb(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const theirPayment = await makePayment(tx, { userId: theirs.id });
      await makePaymentOccurrence(tx, {
        paymentId: theirPayment.id,
        dueDate: TOMORROW,
        status: 'scheduled',
        expectedAmount: '10.00',
      });

      expect(await repo().findDueOnDateForUser(mine.id, TOMORROW, tx)).toEqual([]);
    });
  });
});
