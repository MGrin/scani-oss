import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { Container } from 'typedi';
import { PaymentOccurrenceRepository } from '../../../src/repositories/PaymentOccurrenceRepository';
import { PaymentRepository } from '../../../src/repositories/PaymentRepository';
import {
  PaymentHasSettledOccurrencesError,
  PaymentService,
} from '../../../src/services/payments/PaymentService';
import { withTestDb } from '../../../test/helpers/db';
import { makeDocument, makeDocumentExtraction, makeUser } from '../../../test/helpers/factories';
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

// Same idea, but on an explicit day-of-month. The settlement-remap
// tests below pin their anchors to a mid-month day so that shifting one
// by a couple of days can never involve `recurrence.ts`'s end-of-month
// clamping — the expected dates stay literal and the assertions stay
// independent of the generator they're checking.
function monthsFromNowOnDay(monthOffset: number, dayOfMonth: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, dayOfMonth))
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

        const first = await service().materialise(payment, tx);
        expect(first.length).toBeGreaterThan(0);

        const afterFirst = await occurrences().findByPaymentId(payment.id, tx);
        await service().materialise(payment, tx);
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

        await service().materialise(payment, tx);

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

        const created = await service().materialise(payment, tx);

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

        await service().materialise(payment, tx);
        const afterFirst = await occurrences().findByPaymentId(payment.id, tx);

        // Simulates the scheduled re-run mentioned in the spec — same
        // payment, later call, no change to its shape.
        await service().materialise(payment, tx);
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

        await service().materialise(payment, tx);
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

        await service().materialise(payment, tx);

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
        await service().materialise(payment, tx);

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
        await service().materialise(payment, tx);
        const before = await occurrences().findByPaymentId(payment.id, tx);

        await service().update(user.id, payment.id, { notes: 'unrelated change' }, tx);

        const after = await occurrences().findByPaymentId(payment.id, tx);
        expect(after).toEqual(before);
      });
    });
  });

  // Regression suite for the settlement-stranding bug: moving a
  // recurring payment's anchor used to leave the already-paid
  // occurrence on a date the new rule no longer generates, while
  // re-materialisation inserted a fresh unpaid row for the same period
  // — one ghost plus one duplicate ask-to-pay.
  describe('update — settled occurrences follow a schedule-shape change', () => {
    // A monthly payment anchored three months back on the 10th, with
    // the occurrence from two months ago already paid off an invoice.
    async function makeSettledMonthlyPayment(tx: DatabaseTransaction, anchorDay = 10) {
      const user = await makeUser(tx);
      const payment = await makePayment(tx, {
        userId: user.id,
        anchorDate: monthsFromNowOnDay(-3, anchorDay),
        intervalUnit: 'month',
        intervalCount: 1,
        expectedAmount: '12.99',
      });
      await service().materialise(payment, tx);

      const document = await makeDocument(tx, { userId: user.id });
      const extraction = await makeDocumentExtraction(tx, { documentId: document.id });

      const settledDueDate = monthsFromNowOnDay(-2, anchorDay);
      const target = await occurrences().findByPaymentIdAndDueDate(payment.id, settledDueDate, tx);
      if (!target) throw new Error(`expected a materialised occurrence on ${settledDueDate}`);

      const settled = await service().settleOccurrence(
        user.id,
        target.id,
        { status: 'matched', actualAmount: '13.50', matchedExtractionId: extraction.id },
        tx
      );

      return { user, payment, extraction, settled };
    }

    test('moving the anchor back two days moves the settled occurrence with it, leaving one settled row', async () => {
      await withTestDb(async (tx) => {
        const { user, payment, extraction, settled } = await makeSettledMonthlyPayment(tx);

        await service().update(user.id, payment.id, { anchorDate: monthsFromNowOnDay(-3, 8) }, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const settledRows = rows.filter((r) => r.status !== 'scheduled');

        expect(settledRows.length).toBe(1);
        expect(settledRows[0]?.id).toBe(settled.id);
        expect(settledRows[0]?.dueDate).toBe(monthsFromNowOnDay(-2, 8));
        expect(settledRows[0]?.matchedExtractionId).toBe(extraction.id);
        expect(settledRows[0]?.actualAmount).toBe('13.50');

        // The ghost is gone: nothing is left on the date the old rule
        // produced, and the period it covers has no unpaid twin.
        expect(rows.filter((r) => r.dueDate === settled.dueDate)).toEqual([]);
        expect(rows.filter((r) => r.dueDate === monthsFromNowOnDay(-2, 8)).length).toBe(1);
      });
    });

    test('moving the anchor forward two days moves the settled occurrence with it, leaving one settled row', async () => {
      await withTestDb(async (tx) => {
        const { user, payment, extraction, settled } = await makeSettledMonthlyPayment(tx);

        await service().update(user.id, payment.id, { anchorDate: monthsFromNowOnDay(-3, 12) }, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const settledRows = rows.filter((r) => r.status !== 'scheduled');

        expect(settledRows.length).toBe(1);
        expect(settledRows[0]?.id).toBe(settled.id);
        expect(settledRows[0]?.dueDate).toBe(monthsFromNowOnDay(-2, 12));
        expect(settledRows[0]?.matchedExtractionId).toBe(extraction.id);
        expect(settledRows[0]?.actualAmount).toBe('13.50');

        expect(rows.filter((r) => r.dueDate === settled.dueDate)).toEqual([]);
        expect(rows.filter((r) => r.dueDate === monthsFromNowOnDay(-2, 12)).length).toBe(1);
      });
    });

    test('an unpaid row already sitting on the settled occurrence’s new date is displaced, not duplicated', async () => {
      await withTestDb(async (tx) => {
        const { user, payment, settled } = await makeSettledMonthlyPayment(tx);

        // A stale unpaid row from an earlier shape, squatting exactly
        // where the settled occurrence is about to land.
        const twin = await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: monthsFromNowOnDay(-2, 8),
          expectedAmount: '12.99',
        });

        await service().update(user.id, payment.id, { anchorDate: monthsFromNowOnDay(-3, 8) }, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const landed = rows.filter((r) => r.dueDate === monthsFromNowOnDay(-2, 8));

        expect(landed.length).toBe(1);
        expect(landed[0]?.id).toBe(settled.id);
        expect(landed[0]?.status).toBe('matched');
        expect(rows.some((r) => r.id === twin.id)).toBe(false);
      });
    });

    test('changing only the amount leaves settled occurrences exactly where they are', async () => {
      await withTestDb(async (tx) => {
        const { user, payment, settled } = await makeSettledMonthlyPayment(tx);

        await service().update(user.id, payment.id, { expectedAmount: '19.99' }, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const settledRow = rows.find((r) => r.id === settled.id);

        expect(settledRow).toEqual(settled);
        // …and the amount edit still took its own path.
        expect(
          rows
            .filter((r) => r.status === 'scheduled' && r.dueDate >= todayUtcString())
            .every((r) => r.expectedAmount === '19.99')
        ).toBe(true);
      });
    });

    test('a settled occurrence the shortened schedule has no slot for survives where it is', async () => {
      await withTestDb(async (tx) => {
        const { user, payment, extraction, settled } = await makeSettledMonthlyPayment(tx);

        // Ends the payment before the settled occurrence's own period,
        // so the new sequence is too short to have an ordinal twin for it.
        await service().update(user.id, payment.id, { endDate: monthsFromNowOnDay(-3, 20) }, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const survivor = rows.find((r) => r.id === settled.id);

        expect(survivor?.dueDate).toBe(settled.dueDate);
        expect(survivor?.status).toBe('matched');
        expect(survivor?.matchedExtractionId).toBe(extraction.id);
        expect(survivor?.actualAmount).toBe('13.50');
      });
    });

    test('a quarterly payment pairs by ordinal, not by day offset, when the anchor moves', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: user.id,
          anchorDate: monthsFromNowOnDay(-6, 10),
          intervalUnit: 'quarter',
          intervalCount: 1,
          expectedAmount: '99.00',
        });
        await service().materialise(payment, tx);

        const target = await occurrences().findByPaymentIdAndDueDate(
          payment.id,
          monthsFromNowOnDay(-3, 10),
          tx
        );
        if (!target) throw new Error('expected the second quarterly occurrence');
        const settled = await service().settleOccurrence(
          user.id,
          target.id,
          { status: 'matched', actualAmount: '99.00' },
          tx
        );

        await service().update(user.id, payment.id, { anchorDate: monthsFromNowOnDay(-6, 8) }, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const settledRows = rows.filter((r) => r.status !== 'scheduled');

        expect(settledRows.length).toBe(1);
        expect(settledRows[0]?.id).toBe(settled.id);
        // One quarter after the new anchor — not "the old date minus
        // two days" by coincidence of arithmetic, but the second slot
        // the new rule generates.
        expect(settledRows[0]?.dueDate).toBe(monthsFromNowOnDay(-3, 8));
      });
    });
  });

  // Regression suite for the paused-edit wipe: `update`'s shape-change
  // branch deletes every `scheduled` row and re-materialises, but
  // `generateOccurrences` refuses to expand a paused schedule — so the
  // delete ran, the regenerate returned nothing, and a paused payment
  // came out of a routine edit with an empty schedule and a success
  // toast. Nothing asserted the pair stayed balanced, which is how half
  // of it shipped silently disabled.
  describe('update — a paused payment keeps its schedule', () => {
    async function makeMonthlyPayment(tx: DatabaseTransaction, userId: string) {
      const payment = await makePayment(tx, {
        userId,
        anchorDate: monthsFromNowOnDay(-3, 10),
        intervalUnit: 'month',
        intervalCount: 1,
        expectedAmount: '12.99',
      });
      await service().materialise(payment, tx);
      return payment;
    }

    test('a shape edit produces the same due dates whether the payment is paused or active', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const active = await makeMonthlyPayment(tx, user.id);
        const paused = await makeMonthlyPayment(tx, user.id);
        await service().pause(user.id, paused.id, tx);

        const newAnchor = monthsFromNowOnDay(-3, 12);
        await service().update(user.id, active.id, { anchorDate: newAnchor }, tx);
        await service().update(user.id, paused.id, { anchorDate: newAnchor }, tx);

        const dates = async (paymentId: string) =>
          (await occurrences().findByPaymentId(paymentId, tx)).map((o) => o.dueDate).sort();

        const activeDates = await dates(active.id);
        const pausedDates = await dates(paused.id);

        // The pause governs whether the rule keeps producing NEW due
        // dates, not which dates the rule names. An edit must land the
        // same either way.
        expect(activeDates.length).toBeGreaterThan(1);
        expect(pausedDates).toEqual(activeDates);
        expect(pausedDates.every((d) => d.endsWith('-12'))).toBe(true);
      });
    });

    test('the payment stays paused, and the rows it keeps are all still scheduled', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makeMonthlyPayment(tx, user.id);
        await service().pause(user.id, payment.id, tx);

        const updated = await service().update(
          user.id,
          payment.id,
          { anchorDate: monthsFromNowOnDay(-3, 12) },
          tx
        );

        expect(updated.status).toBe('paused');
        expect(updated.pausedAt).not.toBeNull();

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        expect(rows.length).toBeGreaterThan(1);
        expect(rows.every((o) => o.status === 'scheduled')).toBe(true);
      });
    });

    test('a settled row follows the shape change while paused, with no unpaid twin beside it', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makeMonthlyPayment(tx, user.id);

        const target = await occurrences().findByPaymentIdAndDueDate(
          payment.id,
          monthsFromNowOnDay(-2, 10),
          tx
        );
        if (!target) throw new Error('expected a materialised occurrence to settle');
        const settled = await service().settleOccurrence(
          user.id,
          target.id,
          { status: 'matched', actualAmount: '13.50' },
          tx
        );

        await service().pause(user.id, payment.id, tx);
        await service().update(user.id, payment.id, { anchorDate: monthsFromNowOnDay(-3, 8) }, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const settledRows = rows.filter((r) => r.status !== 'scheduled');

        // Being paused must not exempt a settled row from the ordinal
        // pairing: leaving it on the old rule's date while the new rule
        // materialises its own is exactly the ghost-plus-duplicate the
        // remap exists to prevent.
        expect(settledRows.length).toBe(1);
        expect(settledRows[0]?.id).toBe(settled.id);
        expect(settledRows[0]?.dueDate).toBe(monthsFromNowOnDay(-2, 8));
        expect(settledRows[0]?.actualAmount).toBe('13.50');
        expect(rows.filter((r) => r.dueDate === monthsFromNowOnDay(-2, 10))).toEqual([]);
      });
    });

    test('resuming after a paused edit adds nothing the edit did not already write', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makeMonthlyPayment(tx, user.id);
        await service().pause(user.id, payment.id, tx);
        await service().update(user.id, payment.id, { anchorDate: monthsFromNowOnDay(-3, 12) }, tx);

        const afterEdit = (await occurrences().findByPaymentId(payment.id, tx)).map(
          (o) => o.dueDate
        );
        await service().resume(user.id, payment.id, tx);
        const afterResume = (await occurrences().findByPaymentId(payment.id, tx)).map(
          (o) => o.dueDate
        );

        // Resume re-materialises from the same anchor, so it must find
        // every slot already filled — nothing appears, nothing doubles.
        expect(afterResume).toEqual(afterEdit);
      });
    });

    test('editing only the amount while paused still repriced the future rows it left in place', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makeMonthlyPayment(tx, user.id);
        await service().pause(user.id, payment.id, tx);

        await service().update(user.id, payment.id, { expectedAmount: '19.99' }, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        expect(rows.length).toBeGreaterThan(1);
        expect(
          rows
            .filter((r) => r.dueDate >= todayUtcString())
            .every((r) => r.expectedAmount === '19.99')
        ).toBe(true);
      });
    });
  });

  describe('ownership', () => {
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
        await service().materialise(payment, tx);
        const before = await occurrences().findByPaymentId(payment.id, tx);

        const paused = await service().pause(user.id, payment.id, tx);
        expect(paused.status).toBe('paused');

        // The PAUSED row, not the object `makePayment` returned — the
        // pause is a fact about the row, and re-materialising a stale
        // active copy would assert nothing about a paused payment.
        await service().materialise(paused, tx);
        const after = await occurrences().findByPaymentId(payment.id, tx);
        expect(after.length).toBe(before.length);
      });
    });

    test('records when the pause started, and re-pausing does not move that', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id, anchorDate: todayUtcString() });

        const paused = await service().pause(user.id, payment.id, tx);
        expect(paused.pausedAt).not.toBeNull();

        // Re-pausing must keep the ORIGINAL window: the elapsed due dates
        // fell inside the first pause, not a second one starting now.
        const again = await service().pause(user.id, payment.id, tx);
        expect(again.pausedAt?.getTime()).toBe(paused.pausedAt?.getTime());
      });
    });
  });

  describe('resume', () => {
    // A weekly cadence anchored a whole number of weeks back, so every
    // expected due date is a fixed number of days from today regardless of
    // the month — the month-length clamping in `recurrence.ts` can't make
    // these assertions drift.
    async function makeWeeklyPausedPayment(tx: DatabaseTransaction, pausedDaysAgo: number) {
      const user = await makeUser(tx);
      const payment = await makePayment(tx, {
        userId: user.id,
        intervalUnit: 'week',
        intervalCount: 1,
        anchorDate: pastDateString(28),
      });
      await service().materialise(payment, tx);
      await service().pause(user.id, payment.id, tx);
      // Backdate the pause: `pause` stamps "now", and these tests need a
      // window that already spans due dates.
      await payments().update(
        payment.id,
        { pausedAt: new Date(`${pastDateString(pausedDaysAgo)}T00:00:00.000Z`) },
        tx
      );
      return { user, payment };
    }

    test('restores the ORIGINAL schedule — the anchor never moves', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const anchor = pastDateString(28);
        const payment = await makePayment(tx, {
          userId: user.id,
          intervalUnit: 'week',
          intervalCount: 1,
          anchorDate: anchor,
        });
        await service().materialise(payment, tx);
        const beforePause = (await occurrences().findByPaymentId(payment.id, tx)).map(
          (o) => o.dueDate
        );

        await service().pause(user.id, payment.id, tx);
        const resumed = await service().resume(user.id, payment.id, tx);

        expect(resumed.status).toBe('active');
        expect(resumed.pausedAt).toBeNull();
        expect(resumed.anchorDate).toBe(anchor);

        // Same dates, not a schedule restarted from today. Resume is not
        // an edit to the rule.
        const afterResume = (await occurrences().findByPaymentId(payment.id, tx)).map(
          (o) => o.dueDate
        );
        expect(afterResume).toEqual(beforePause);
      });
    });

    test('due dates the pause covered become skipped, and none of them come back overdue', async () => {
      await withTestDb(async (tx) => {
        const { user, payment } = await makeWeeklyPausedPayment(tx, 15);

        await service().resume(user.id, payment.id, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const statusByDate = new Map(rows.map((o) => [o.dueDate, o.status]));

        // Inside the window [15 days ago, today).
        expect(statusByDate.get(pastDateString(14))).toBe('skipped');
        expect(statusByDate.get(pastDateString(7))).toBe('skipped');

        // Already overdue BEFORE the pause started — the user never
        // decided anything about these, so they keep standing.
        expect(statusByDate.get(pastDateString(28))).toBe('scheduled');
        expect(statusByDate.get(pastDateString(21))).toBe('scheduled');

        // Today is active again, so today's due date is live, not skipped.
        expect(statusByDate.get(todayUtcString())).toBe('scheduled');

        // Nothing in the window is left standing as a debt.
        const overdueInWindow = rows.filter(
          (o) =>
            o.status === 'scheduled' &&
            o.dueDate >= pastDateString(15) &&
            o.dueDate < todayUtcString()
        );
        expect(overdueInWindow).toEqual([]);
      });
    });

    test('a settled occurrence inside the pause window is never overwritten', async () => {
      await withTestDb(async (tx) => {
        const { user, payment } = await makeWeeklyPausedPayment(tx, 15);
        const matched = await occurrences().findByPaymentIdAndDueDate(
          payment.id,
          pastDateString(14),
          tx
        );
        if (!matched) throw new Error('expected an occurrence 14 days ago');
        await service().settleOccurrence(
          user.id,
          matched.id,
          { status: 'matched', actualAmount: '9.99' },
          tx
        );

        await service().resume(user.id, payment.id, tx);

        const after = await occurrences().findByPaymentIdAndDueDate(
          payment.id,
          pastDateString(14),
          tx
        );
        expect(after?.status).toBe('matched');
        expect(after?.actualAmount).toBe('9.99');
      });
    });

    test('pausing and resuming on the same day changes nothing', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: user.id,
          intervalUnit: 'week',
          intervalCount: 1,
          anchorDate: pastDateString(28),
        });
        await service().materialise(payment, tx);
        const before = await occurrences().findByPaymentId(payment.id, tx);

        await service().pause(user.id, payment.id, tx);
        await service().resume(user.id, payment.id, tx);

        const after = await occurrences().findByPaymentId(payment.id, tx);
        expect(after.map((o) => [o.dueDate, o.status])).toEqual(
          before.map((o) => [o.dueDate, o.status])
        );
      });
    });

    test('resuming an already-active payment is a no-op, not an error', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: user.id,
          intervalUnit: 'week',
          intervalCount: 1,
          anchorDate: pastDateString(28),
        });
        await service().materialise(payment, tx);
        const before = await occurrences().findByPaymentId(payment.id, tx);

        const resumed = await service().resume(user.id, payment.id, tx);
        expect(resumed.status).toBe('active');

        const after = await occurrences().findByPaymentId(payment.id, tx);
        expect(after.map((o) => [o.dueDate, o.status])).toEqual(
          before.map((o) => [o.dueDate, o.status])
        );
      });
    });

    test('refuses to resume an ended payment', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id, anchorDate: todayUtcString() });
        await service().end(user.id, payment.id, todayUtcString(), tx);

        await expect(service().resume(user.id, payment.id, tx)).rejects.toThrow(
          /cannot be resumed/
        );
      });
    });

    test('a payment paused before pausedAt existed resumes without skipping anything', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: user.id,
          intervalUnit: 'week',
          intervalCount: 1,
          anchorDate: pastDateString(28),
        });
        await service().materialise(payment, tx);
        // The legacy shape: paused, with no recorded pause start.
        await payments().update(payment.id, { status: 'paused', pausedAt: null }, tx);

        await service().resume(user.id, payment.id, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        expect(rows.some((o) => o.status === 'skipped')).toBe(false);
      });
    });

    test('a pause longer than the materialisation horizon still skips its whole window', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        // Anchored well over a year back, so the rows for the tail of the
        // pause window only come into existence when `resume`
        // re-materialises — they must be skipped, not surface as debts.
        const payment = await makePayment(tx, {
          userId: user.id,
          intervalUnit: 'month',
          intervalCount: 1,
          anchorDate: monthsFromNowOnDay(-20, 10),
          status: 'paused',
          pausedAt: new Date(`${monthsFromNowOnDay(-18, 10)}T00:00:00.000Z`),
        });

        await service().resume(user.id, payment.id, tx);

        const rows = await occurrences().findByPaymentId(payment.id, tx);
        const inWindow = rows.filter(
          (o) => o.dueDate >= monthsFromNowOnDay(-18, 10) && o.dueDate < todayUtcString()
        );
        expect(inWindow.length).toBeGreaterThan(12);
        expect(inWindow.every((o) => o.status === 'skipped')).toBe(true);
        // And the schedule ahead is live again.
        expect(rows.some((o) => o.dueDate > todayUtcString() && o.status === 'scheduled')).toBe(
          true
        );
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
        await service().materialise(payment, tx);
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

  describe('schedule change clears derived past rows', () => {
    // Regression: the delete used to be bounded at `today`, so the OLD
    // rule's past `scheduled` rows survived while `materialiseSchedule` —
    // which starts at the payment's anchor, not today — inserted the NEW
    // rule's past dates beside them. A monthly bill moved a couple of days
    // then showed two overdue rows for every past period.
    test('moving the anchor leaves one unpaid row per past period, not two', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const oldAnchor = monthsFromNowOnDay(-3, 10);
        const payment = await makePayment(tx, {
          userId: user.id,
          intervalUnit: 'month',
          intervalCount: 1,
          anchorDate: oldAnchor,
        });
        await service().materialise(payment, tx);

        const beforeEdit = await occurrences().findByPaymentId(payment.id, tx);
        const pastBefore = beforeEdit.filter((o) => o.dueDate < todayUtcString());
        expect(pastBefore.length).toBeGreaterThan(0);

        await service().update(user.id, payment.id, { anchorDate: monthsFromNowOnDay(-3, 12) }, tx);

        const after = await occurrences().findByPaymentId(payment.id, tx);
        const pastDates = after.filter((o) => o.dueDate < todayUtcString()).map((o) => o.dueDate);
        // Every surviving past row belongs to the NEW rule — none on the
        // 10th — and there is exactly one per period. The count is NOT
        // asserted equal to before: shifting the anchor from the 10th to
        // the 12th moves one date across "today" on some days of the
        // month, which is correct and not what this regression is about.
        expect(pastDates.length).toBeGreaterThan(0);
        expect(pastDates.every((d) => d.endsWith('-12'))).toBe(true);
        expect(new Set(pastDates).size).toBe(pastDates.length);
      });
    });
  });

  // SC-83. `delete` and `end` are two different claims about the same record —
  // "this should never have existed" and "this really ran and has stopped" —
  // and the whole value of having both is that only one of them destroys
  // history. These tests pin the line between them.
  describe('delete', () => {
    test('removes the payment and cascades every occurrence with it', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, {
          userId: user.id,
          intervalUnit: 'month',
          intervalCount: 1,
          anchorDate: pastDateString(60),
        });
        await service().materialise(payment, tx);
        expect((await occurrences().findByPaymentId(payment.id, tx)).length).toBeGreaterThan(0);

        const impact = await service().delete(user.id, payment.id, tx);
        expect(impact.settled).toBe(0);
        expect(impact.scheduled).toBeGreaterThan(0);

        expect(await payments().findByIdAndUser(payment.id, user.id, tx)).toBeNull();
        // ON DELETE CASCADE, so nothing has to be swept afterwards.
        expect(await occurrences().findByPaymentId(payment.id, tx)).toHaveLength(0);
      });
    });

    test('refuses a payment with a settled occurrence, and destroys nothing', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: pastDateString(30),
          status: 'matched',
          actualAmount: '12.99',
        });

        const attempt = service().delete(user.id, payment.id, tx);
        await expect(attempt).rejects.toThrow(PaymentHasSettledOccurrencesError);

        const error = await attempt.catch((thrown: unknown) => thrown);
        expect((error as PaymentHasSettledOccurrencesError).settledCount).toBe(1);

        expect(await payments().findByIdAndUser(payment.id, user.id, tx)).not.toBeNull();
        expect(await occurrences().findByPaymentId(payment.id, tx)).toHaveLength(1);
      });
    });

    test('a skipped occurrence is discarded, not a blocker', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: pastDateString(30),
          status: 'skipped',
        });

        // A deliberate "not this month" on a payment that should never have
        // existed is a decision about a mistake — it is named in the
        // confirmation, and it does not describe money that moved.
        const impact = await service().delete(user.id, payment.id, tx);
        expect(impact).toEqual({ scheduled: 0, settled: 0, skipped: 1 });
        expect(await payments().findByIdAndUser(payment.id, user.id, tx)).toBeNull();
      });
    });

    test("another user's payment is not found, and is not deleted", async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const stranger = await makeUser(tx);
        const payment = await makePayment(tx, { userId: owner.id });

        await expect(service().delete(stranger.id, payment.id, tx)).rejects.toThrow('not found');
        expect(await payments().findByIdAndUser(payment.id, owner.id, tx)).not.toBeNull();
      });
    });

    test('deleteImpact counts the three kinds without writing anything', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: pastDateString(60),
          status: 'matched',
        });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: pastDateString(30),
          status: 'skipped',
        });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: todayUtcString(),
          status: 'scheduled',
        });

        expect(await service().deleteImpact(user.id, payment.id, tx)).toEqual({
          scheduled: 1,
          settled: 1,
          skipped: 1,
        });
        expect(await occurrences().findByPaymentId(payment.id, tx)).toHaveLength(3);
      });
    });

    test('end keeps the record delete would have removed', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const payment = await makePayment(tx, { userId: user.id });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: pastDateString(30),
          status: 'matched',
        });

        // The pair, stated as one assertion: the operation delete refuses is
        // exactly the operation end is for, and end leaves the history intact.
        const ended = await service().end(user.id, payment.id, undefined, tx);
        expect(ended.status).toBe('ended');
        expect(await payments().findByIdAndUser(payment.id, user.id, tx)).not.toBeNull();
        expect(await occurrences().findByPaymentId(payment.id, tx)).toHaveLength(1);
      });
    });
  });
});
