import { describe, expect, test } from 'bun:test';
import { generateOccurrences } from '../../../src/services/payments/recurrence';
import {
  planSettledRemap,
  type RemappableOccurrence,
} from '../../../src/services/payments/remapSettledOccurrences';

function occurrence(
  id: string,
  dueDate: string,
  status: RemappableOccurrence['status'] = 'scheduled'
): RemappableOccurrence {
  return { id, dueDate, status };
}

// The dates a monthly rule anchored at `anchor` produces, as
// `materialiseSchedule` generates them: from the anchor itself, so
// index i really is the i-th occurrence.
function monthlySequence(anchor: string, months: number): string[] {
  const anchorDate = new Date(`${anchor}T00:00:00.000Z`);
  const to = new Date(
    Date.UTC(
      anchorDate.getUTCFullYear(),
      anchorDate.getUTCMonth() + months,
      anchorDate.getUTCDate()
    )
  );
  return generateOccurrences(
    {
      intervalUnit: 'month',
      intervalCount: 1,
      anchorDate,
      status: 'active',
      endDate: null,
      expectedAmount: null,
    },
    anchorDate,
    to
  ).map((candidate) => candidate.dueDate.toISOString().slice(0, 10));
}

describe('planSettledRemap', () => {
  test('moves a settled occurrence to the same ordinal position in the new sequence', () => {
    const oldDueDates = ['2026-03-10', '2026-04-10', '2026-05-10'];
    const newDueDates = ['2026-03-08', '2026-04-08', '2026-05-08'];

    const plan = planSettledRemap(
      [
        occurrence('a', '2026-03-10', 'matched'),
        occurrence('b', '2026-04-10'),
        occurrence('c', '2026-05-10'),
      ],
      oldDueDates,
      newDueDates
    );

    expect(plan.moves).toEqual([
      { occurrenceId: 'a', fromDueDate: '2026-03-10', toDueDate: '2026-03-08' },
    ]);
    expect(plan.strandedOccurrenceIds).toEqual([]);
    expect(plan.displacedOccurrenceIds).toEqual([]);
  });

  // The reason the pairing is ordinal and not a day delta: a rule
  // anchored on the 31st clamps to each month's real length, so
  // "+/- N days" is a different date every month.
  test('follows month-end clamping instead of applying a fixed day offset', () => {
    const oldDueDates = monthlySequence('2026-01-31', 3);
    const newDueDates = monthlySequence('2026-01-30', 3);

    expect(oldDueDates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(newDueDates).toEqual(['2026-01-30', '2026-02-28', '2026-03-30', '2026-04-30']);

    const plan = planSettledRemap(
      [
        occurrence('feb', '2026-02-28', 'matched'),
        occurrence('mar', '2026-03-31', 'matched'),
        occurrence('apr', '2026-04-30', 'matched'),
      ],
      oldDueDates,
      newDueDates
    );

    // February and April already sit on their new ordinal date (the
    // clamp collapses both anchors onto the same day) — only March moves.
    expect(plan.moves).toEqual([
      { occurrenceId: 'mar', fromDueDate: '2026-03-31', toDueDate: '2026-03-30' },
    ]);
  });

  test('displaces an unpaid row occupying the slot a settled occurrence moves into', () => {
    const plan = planSettledRemap(
      [
        occurrence('settled', '2026-04-10', 'matched'),
        occurrence('twin', '2026-04-08'), // an unpaid row already sitting on the new date
      ],
      ['2026-03-10', '2026-04-10'],
      ['2026-03-08', '2026-04-08']
    );

    expect(plan.moves).toEqual([
      { occurrenceId: 'settled', fromDueDate: '2026-04-10', toDueDate: '2026-04-08' },
    ]);
    expect(plan.displacedOccurrenceIds).toEqual(['twin']);
  });

  test('strands a settled occurrence the shortened new sequence has no slot for', () => {
    const plan = planSettledRemap(
      [occurrence('late', '2026-05-10', 'matched')],
      ['2026-03-10', '2026-04-10', '2026-05-10'],
      ['2026-03-08', '2026-04-08']
    );

    expect(plan.moves).toEqual([]);
    expect(plan.strandedOccurrenceIds).toEqual(['late']);
  });

  test('leaves a settled occurrence that never belonged to the old sequence alone', () => {
    const plan = planSettledRemap(
      [occurrence('imported', '2025-11-02', 'matched')],
      ['2026-03-10', '2026-04-10'],
      ['2026-03-08', '2026-04-08']
    );

    expect(plan).toEqual({ moves: [], displacedOccurrenceIds: [], strandedOccurrenceIds: [] });
  });

  // A forward shift smaller than the interval makes every settled row
  // want the slot the NEXT one currently holds. Applying the moves in
  // the emitted order must never transiently collide.
  test('orders overlapping moves so no two settled rows share a due date mid-flight', () => {
    const oldDueDates = ['2026-03-10', '2026-04-10', '2026-05-10'];
    const newDueDates = ['2026-04-10', '2026-05-10', '2026-06-10'];

    const plan = planSettledRemap(
      [
        occurrence('a', '2026-03-10', 'matched'),
        occurrence('b', '2026-04-10', 'matched'),
        occurrence('c', '2026-05-10', 'matched'),
      ],
      oldDueDates,
      newDueDates
    );

    expect(plan.strandedOccurrenceIds).toEqual([]);
    expect(plan.moves.map((move) => move.occurrenceId)).toEqual(['c', 'b', 'a']);

    const occupied = new Set(['2026-03-10', '2026-04-10', '2026-05-10']);
    for (const move of plan.moves) {
      expect(occupied.has(move.toDueDate)).toBe(false);
      occupied.delete(move.fromDueDate);
      occupied.add(move.toDueDate);
    }
  });

  test('keeps both settled rows when one would land on another settled row', () => {
    const plan = planSettledRemap(
      [occurrence('mover', '2026-03-10', 'matched'), occurrence('tenant', '2026-04-10', 'skipped')],
      ['2026-03-10', '2026-04-10'],
      // 'tenant' has no slot (the new sequence is one shorter), so it
      // stays on 2026-04-10 — exactly where 'mover' is sent.
      ['2026-04-10']
    );

    expect(plan.moves).toEqual([]);
    expect(plan.strandedOccurrenceIds.sort()).toEqual(['mover', 'tenant']);
  });
});
