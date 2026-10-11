import { splitByDueness, withinDays } from './money';

/** A bill due within this many days is something to act on now (SC-1669). */
const DUE_SOON_DAYS = 3;

export type NeedsYouRow =
  | { kind: 'review'; count: number }
  /** `onlyId` names the bill when there is exactly one, so its row opens it. */
  | { kind: 'overdue' | 'dueSoon'; count: number; onlyId: string | null };

/**
 * What asks the person to act, in the order they should: questions only they
 * can answer, then money already late, then money about to be. A source that
 * has not answered is `null` and adds no row — a zero would claim the queue
 * is clear when nobody looked.
 */
export function needsYouRows({
  reviewCount,
  bills,
  today,
}: {
  reviewCount: number | null;
  bills: readonly { id: string; dueDate: string }[] | null;
  today: string;
}): NeedsYouRow[] {
  const rows: NeedsYouRow[] = [];
  if (reviewCount !== null && reviewCount > 0) rows.push({ kind: 'review', count: reviewCount });
  if (bills !== null) {
    const { overdue, ahead } = splitByDueness(bills, today);
    const soon = withinDays(ahead, today, DUE_SOON_DAYS);
    for (const [kind, set] of [
      ['overdue', overdue],
      ['dueSoon', soon],
    ] as const) {
      if (set.length > 0) {
        rows.push({
          kind,
          count: set.length,
          onlyId: set.length === 1 ? (set[0]?.id ?? null) : null,
        });
      }
    }
  }
  return rows;
}
