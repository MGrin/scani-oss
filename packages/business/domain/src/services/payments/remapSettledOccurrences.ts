// Settlements follow the schedule.
//
// When a payment's schedule SHAPE changes (anchor, interval, end date),
// `PaymentService.update` deletes the untouched future `scheduled` rows
// and re-materialises from the new rule. Settled rows — anything not
// `scheduled` — are deliberately spared by that delete, which means a
// moved anchor used to leave them sitting on a date the schedule no
// longer produces, while a fresh unpaid row appeared at the new date
// for the same real-world period.
//
// The pairing is ORDINAL, not a day delta: `intervalUnit` may be
// month/quarter/year, where a fixed offset is wrong (`recurrence.ts`
// clamps Jan 31 -> Feb 28 -> Mar 31). The nth occurrence of the old
// sequence is the nth occurrence of the new one.

// The narrow view of a `payment_occurrences` row this planner needs.
// Kept structural, like `RecurrenceSchedule`, so the module stays a
// pure function with no `@scani/db` dependency.
export interface RemappableOccurrence {
  id: string;
  dueDate: string; // 'YYYY-MM-DD'
  status: string;
}

interface OccurrenceMove {
  occurrenceId: string;
  fromDueDate: string;
  toDueDate: string;
}

export interface SettledRemapPlan {
  // Ordered: applying them in sequence never transiently violates the
  // `(payment_id, due_date)` unique constraint.
  moves: OccurrenceMove[];
  // Untouched `scheduled` rows whose date a settled row is taking over.
  // These are the unpaid twins the bug produced; they must go before
  // the move that lands on them.
  displacedOccurrenceIds: string[];
  // Settled rows the new sequence has no slot for. Left exactly where
  // they are — an out-of-schedule row is recoverable, a deleted record
  // of a real payment is not.
  strandedOccurrenceIds: string[];
}

function isSettled(occurrence: RemappableOccurrence): boolean {
  return occurrence.status !== 'scheduled';
}

/**
 * Pair each settled occurrence with its ordinal twin in the new
 * sequence and say what has to happen for it to get there.
 *
 * `oldDueDates` / `newDueDates` must both be generated from their
 * schedule's own `anchorDate` so that index 0 is the anchor in each and
 * index i means "the i-th occurrence of this rule" in both.
 */
export function planSettledRemap(
  occurrences: readonly RemappableOccurrence[],
  oldDueDates: readonly string[],
  newDueDates: readonly string[]
): SettledRemapPlan {
  const oldIndexByDueDate = new Map<string, number>();
  oldDueDates.forEach((dueDate, index) => {
    if (!oldIndexByDueDate.has(dueDate)) {
      oldIndexByDueDate.set(dueDate, index);
    }
  });

  const occupancy = new Map<string, RemappableOccurrence>();
  for (const occurrence of occurrences) {
    occupancy.set(occurrence.dueDate, occurrence);
  }

  const moves: OccurrenceMove[] = [];
  const displacedOccurrenceIds: string[] = [];
  const strandedOccurrenceIds: string[] = [];

  const wanted: Array<{ occurrence: RemappableOccurrence; toDueDate: string }> = [];
  const ordered = [...occurrences].sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  for (const occurrence of ordered) {
    if (!isSettled(occurrence)) continue;

    const index = oldIndexByDueDate.get(occurrence.dueDate);
    // Not a product of the old rule at all (imported history predating
    // the anchor, a row from an even older shape). Nothing to pair it
    // with, so nothing to move.
    if (index === undefined) continue;

    const toDueDate = newDueDates[index];
    if (toDueDate === undefined) {
      strandedOccurrenceIds.push(occurrence.id);
      continue;
    }
    if (toDueDate === occurrence.dueDate) continue;

    wanted.push({ occurrence, toDueDate });
  }

  const stillPending = new Set(wanted.map((entry) => entry.occurrence.id));
  let queue = wanted;

  while (queue.length > 0) {
    const blocked: typeof queue = [];

    for (const entry of queue) {
      const occupant = occupancy.get(entry.toDueDate);

      // The slot belongs to another mover that hasn't vacated yet.
      if (occupant && stillPending.has(occupant.id)) {
        blocked.push(entry);
        continue;
      }

      // Two settled rows cannot share a due date, and neither may be
      // dropped. The sitting tenant wins; the mover stays put.
      if (occupant && isSettled(occupant)) {
        strandedOccurrenceIds.push(entry.occurrence.id);
        stillPending.delete(entry.occurrence.id);
        continue;
      }

      if (occupant) {
        displacedOccurrenceIds.push(occupant.id);
        occupancy.delete(occupant.dueDate);
      }

      if (occupancy.get(entry.occurrence.dueDate) === entry.occurrence) {
        occupancy.delete(entry.occurrence.dueDate);
      }
      occupancy.set(entry.toDueDate, entry.occurrence);
      moves.push({
        occurrenceId: entry.occurrence.id,
        fromDueDate: entry.occurrence.dueDate,
        toDueDate: entry.toDueDate,
      });
      stillPending.delete(entry.occurrence.id);
    }

    // No mover could advance — only reachable if the pairing formed a
    // cycle, which an index-wise map between two increasing sequences
    // cannot. Strand rather than loop forever.
    if (blocked.length === queue.length) {
      for (const entry of blocked) {
        strandedOccurrenceIds.push(entry.occurrence.id);
      }
      break;
    }

    queue = blocked;
  }

  return { moves, displacedOccurrenceIds, strandedOccurrenceIds };
}
