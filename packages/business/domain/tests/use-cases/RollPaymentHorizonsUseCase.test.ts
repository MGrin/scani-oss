import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { Container } from 'typedi';
import { PaymentOccurrenceRepository } from '../../src/repositories/PaymentOccurrenceRepository';
import { PaymentRepository } from '../../src/repositories/PaymentRepository';
import { PaymentService } from '../../src/services/payments/PaymentService';
import { RollPaymentHorizonsUseCase } from '../../src/use-cases/RollPaymentHorizonsUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { makePayment } from '../../test/helpers/factories-extra';

const useCase = () => Container.get(RollPaymentHorizonsUseCase);
const service = () => Container.get(PaymentService);
const occurrences = () => Container.get(PaymentOccurrenceRepository);
const payments = () => Container.get(PaymentRepository);

// Mid-month on purpose: `recurrence.ts` clamps a day-of-month that the
// target month is too short for, and an anchor on the 15th never meets
// that rule, so every expected date below is literal.
const CREATED_AT = '2026-01-15T12:00:00Z';
const FIVE_MONTHS_LATER = '2026-06-15T12:00:00Z';

afterEach(() => setSystemTime());

/**
 * What `payments.upcoming` would return for this payment right now.
 *
 * A copy of the router's own read (`apps/backend/api/src/presentation/
 * routers/payments.ts`): active payments, `scheduled` rows, due on or
 * before today + `days`. The point of the tests below is what a person
 * sees on the Money page and the home Upcoming block, and this is the
 * query behind all eight of those surfaces — asserting on the occurrence
 * count alone would pass on rows no read is capable of reaching.
 */
async function upcoming(
  tx: DatabaseTransaction,
  paymentId: string,
  days: number
): Promise<string[]> {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const horizon = new Date(today.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await occurrences().findByPaymentId(paymentId, tx);
  return rows
    .filter((row) => row.status === 'scheduled' && row.dueDate <= horizon)
    .map((row) => row.dueDate)
    .sort();
}

function futureOnly(dueDates: string[]): string[] {
  const today = new Date().toISOString().slice(0, 10);
  return dueDates.filter((dueDate) => dueDate >= today);
}

describe('RollPaymentHorizonsUseCase', () => {
  test('a payment nobody has touched for five months still fills a full-year read', async () => {
    setSystemTime(new Date(CREATED_AT));
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const stale = await makePayment(tx, {
        userId: user.id,
        anchorDate: '2026-01-15',
        intervalUnit: 'month',
        intervalCount: 1,
        expectedAmount: '12.99',
      });
      await service().materialise(stale, tx);

      // Five months pass. Nothing edits, pauses or resumes the payment —
      // this is the whole of the defect: every other materialising path
      // runs as a side effect of a write, and there is no write here.
      setSystemTime(new Date(FIVE_MONTHS_LATER));

      const before = futureOnly(await upcoming(tx, stale.id, 365));
      expect(before.at(0)).toBe('2026-06-15');
      // The taper. A year-long read reaches 2027-06-15 and the table
      // stops at 2027-01-15, so seven of the twelve months a person asked
      // about come back empty — and read as a bill that has ended.
      expect(before.at(-1)).toBe('2027-01-15');
      expect(before).toHaveLength(8);

      const summary = await useCase().execute(tx);
      expect(summary.horizonEnd).toBe('2027-06-15');
      expect(summary.failed).toBe(0);

      const after = futureOnly(await upcoming(tx, stale.id, 365));
      expect(after.at(0)).toBe('2026-06-15');
      expect(after.at(-1)).toBe('2027-06-15');
      expect(after).toHaveLength(13);
      // The five months that were missing, named rather than counted.
      expect(after).toEqual(
        expect.arrayContaining([
          '2027-02-15',
          '2027-03-15',
          '2027-04-15',
          '2027-05-15',
          '2027-06-15',
        ])
      );
    });
  });

  test('a payment already at its horizon is not selected and gains nothing', async () => {
    setSystemTime(new Date(FIVE_MONTHS_LATER));
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const current = await makePayment(tx, {
        userId: user.id,
        anchorDate: '2026-06-15',
        intervalUnit: 'month',
        intervalCount: 1,
      });
      await service().materialise(current, tx);
      const before = await upcoming(tx, current.id, 365);

      const candidates = await payments().findActiveNeedingHorizonRoll('2027-06-15', tx);
      expect(candidates.map((row) => row.id)).not.toContain(current.id);

      await useCase().execute(tx);

      expect(await upcoming(tx, current.id, 365)).toEqual(before);
    });
  });

  test('does not re-select an active payment that already reaches its own end date', async () => {
    setSystemTime(new Date(CREATED_AT));
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      // Still `active`, but the rule stops in September. Its edge can
      // never reach the twelve-month horizon, so a query comparing
      // against the horizon alone picks it up every night, forever, to
      // generate nothing — which is also a `behind` count that overstates
      // the drift it exists to measure.
      const finite = await makePayment(tx, {
        userId: user.id,
        anchorDate: '2026-01-15',
        endDate: '2026-09-15',
        intervalUnit: 'month',
        intervalCount: 1,
      });
      await service().materialise(finite, tx);

      setSystemTime(new Date(FIVE_MONTHS_LATER));
      const rows = await occurrences().findByPaymentId(finite.id, tx);
      expect(
        rows
          .map((row) => row.dueDate)
          .sort()
          .at(-1)
      ).toBe('2026-09-15');

      const candidates = await payments().findActiveNeedingHorizonRoll('2027-06-15', tx);
      expect(candidates.map((row) => row.id)).not.toContain(finite.id);
    });
  });

  test('leaves a paused payment frozen and does not regrow an ended one', async () => {
    setSystemTime(new Date(CREATED_AT));
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const paused = await makePayment(tx, {
        userId: user.id,
        anchorDate: '2026-01-15',
        intervalUnit: 'month',
        intervalCount: 1,
      });
      const ended = await makePayment(tx, {
        userId: user.id,
        anchorDate: '2026-01-15',
        intervalUnit: 'month',
        intervalCount: 1,
      });
      await service().materialise(paused, tx);
      await service().materialise(ended, tx);

      await service().pause(user.id, paused.id, tx);
      await service().end(user.id, ended.id, '2026-03-15', tx);

      setSystemTime(new Date(FIVE_MONTHS_LATER));
      const pausedBefore = await occurrences().findByPaymentId(paused.id, tx);
      const endedBefore = await occurrences().findByPaymentId(ended.id, tx);

      // Asserted on the SELECTION, not only on the rows. Both payments
      // survive a roll even without the lifecycle filter — a paused
      // schedule expands to nothing and an ended one is bounded by its
      // own `endDate`, so the row assertions below pass either way and
      // say nothing about this query. Without this line, deleting
      // `eq(status, 'active')` from `findActiveNeedingHorizonRoll` leaves
      // every test here green while the sweep picks up every paused and
      // ended payment in the database, every night, to generate nothing.
      const candidates = await payments().findActiveNeedingHorizonRoll('2027-06-15', tx);
      const candidateIds = candidates.map((row) => row.id);
      expect(candidateIds).not.toContain(paused.id);
      expect(candidateIds).not.toContain(ended.id);

      await useCase().execute(tx);

      // A pause deliberately stops the edge advancing until `resume`,
      // which materialises the pause window itself before skipping it.
      // Rolling a paused payment here would hand `resume` dates it has
      // already decided the user did not owe.
      const pausedAfter = await occurrences().findByPaymentId(paused.id, tx);
      expect(pausedAfter.map((row) => row.dueDate).sort()).toEqual(
        pausedBefore.map((row) => row.dueDate).sort()
      );

      // `end` deleted everything after 2026-03-15. Growing it back would
      // claim a bill is still running after the user said it stopped.
      const endedAfter = await occurrences().findByPaymentId(ended.id, tx);
      expect(endedAfter.map((row) => row.dueDate).sort()).toEqual(
        endedBefore.map((row) => row.dueDate).sort()
      );
      expect(endedAfter.every((row) => row.dueDate <= '2026-03-15')).toBe(true);
    });
  });
});
