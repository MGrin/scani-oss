import { Decimal } from '@scani/shared';

/**
 * Finds monthly payments the user makes but never recorded as a recurring
 * payment (SC-674). Pure and read-only: it returns candidates and writes
 * nothing, because writing classifications the user did not make is what
 * cost the forecast his trust (SC-673). Whatever uses this must ask first.
 *
 * "Monthly" means one payment in each consecutive calendar month, not a fixed
 * day gap. The case that motivated this paid on 10 Feb and then 2 Mar, 20
 * days apart, and a 25-35 day window would have missed the whole series.
 */

export interface ObservedOutflow {
  id: string;
  occurredAt: Date;
  /** Positive magnitude of the outflow. */
  amount: string;
  currency: string;
  /** Who was paid. An outflow without one is never grouped. */
  counterparty: string | null;
}

export interface DetectedRecurrence {
  counterparty: string;
  currency: string;
  /** Median of the series. */
  amount: string;
  occurrences: number;
  firstAt: Date;
  lastAt: Date;
  /** `ended` when no payment landed within ACTIVE_WITHIN_DAYS of `asOf`. */
  status: 'active' | 'ended';
  transactionIds: string[];
}

const MIN_OCCURRENCES = 3;
const AMOUNT_TOLERANCE = new Decimal('0.02');
const ACTIVE_WITHIN_DAYS = 45;
const MS_PER_DAY = 86_400_000;

const monthIndex = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();

function median(values: Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as Decimal)
    : (sorted[mid - 1] as Decimal).plus(sorted[mid] as Decimal).div(2);
}

/** Splits one payee's outflows into groups whose amounts sit within tolerance of the group's first. */
function byAmount(rows: ObservedOutflow[]): ObservedOutflow[][] {
  const groups: { anchor: Decimal; rows: ObservedOutflow[] }[] = [];
  for (const row of rows) {
    const amount = new Decimal(row.amount);
    const group = groups.find((g) =>
      amount.minus(g.anchor).abs().lte(g.anchor.times(AMOUNT_TOLERANCE))
    );
    if (group) group.rows.push(row);
    else groups.push({ anchor: amount, rows: [row] });
  }
  return groups.map((g) => g.rows);
}

/** Runs of payments landing in consecutive calendar months, one per month. */
function monthlyRuns(rows: ObservedOutflow[]): ObservedOutflow[][] {
  const runs: ObservedOutflow[][] = [];
  let run: ObservedOutflow[] = [];
  for (const row of rows) {
    const prev = run.at(-1);
    if (prev && monthIndex(row.occurredAt) - monthIndex(prev.occurredAt) === 1) run.push(row);
    else {
      if (run.length > 0) runs.push(run);
      run = [row];
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

export function detectMonthlyRecurrences(
  outflows: ObservedOutflow[],
  asOf: Date
): DetectedRecurrence[] {
  const byPayee = new Map<string, ObservedOutflow[]>();
  for (const row of outflows) {
    if (!row.counterparty) continue;
    const key = `${row.counterparty}\x00${row.currency}`;
    byPayee.set(key, [...(byPayee.get(key) ?? []), row]);
  }

  const found: DetectedRecurrence[] = [];
  for (const rows of byPayee.values()) {
    const sorted = [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    for (const group of byAmount(sorted)) {
      for (const run of monthlyRuns(group)) {
        if (run.length < MIN_OCCURRENCES) continue;
        const first = run[0] as ObservedOutflow;
        const last = run.at(-1) as ObservedOutflow;
        const idleDays = (asOf.getTime() - last.occurredAt.getTime()) / MS_PER_DAY;
        found.push({
          counterparty: first.counterparty as string,
          currency: first.currency,
          amount: median(run.map((r) => new Decimal(r.amount))).toString(),
          occurrences: run.length,
          firstAt: first.occurredAt,
          lastAt: last.occurredAt,
          status: idleDays <= ACTIVE_WITHIN_DAYS ? 'active' : 'ended',
          transactionIds: run.map((r) => r.id),
        });
      }
    }
  }
  return found;
}
