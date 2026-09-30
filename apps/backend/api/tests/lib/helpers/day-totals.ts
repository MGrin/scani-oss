import type { IncludedDailyTotalsRow, IncludedHoldingScopeRow } from '@scani/domain/repositories';
import Decimal from 'decimal.js';
import { type AggregatedDailyPoint, aggregateDailyTotals } from '../../../src/lib/net-worth-series';

/**
 * SC-1369 moved the per-day summing of included holding rows into SQL. These
 * are the two halves of the proof that the output did not change:
 *
 * - `legacyAggregateIncludedHoldingRows` is the JS summation as it stood on
 *   main before the move, copied verbatim. It is the oracle, not a second
 *   implementation to maintain.
 * - `sumByDay` mirrors `findIncludedHoldingDailyTotals`'s GROUP BY, so the
 *   unit tests below keep their row fixtures; the DB-backed test checks the
 *   SQL against the oracle on real rows.
 */
export function sumByDay(rows: IncludedHoldingScopeRow[]): IncludedDailyTotalsRow[] {
  const byDate = new Map<string, IncludedHoldingScopeRow[]>();
  for (const row of rows) {
    const key = String(row.snapshotDate).slice(0, 10);
    byDate.set(key, [...(byDate.get(key) ?? []), row]);
  }
  const sum = (day: IncludedHoldingScopeRow[], pick: (r: IncludedHoldingScopeRow) => string) =>
    day.reduce((acc, r) => acc.add(new Decimal(pick(r))), new Decimal(0)).toString();
  const count = (day: IncludedHoldingScopeRow[], pick: (r: IncludedHoldingScopeRow) => number) =>
    day.reduce((acc, r) => acc + pick(r), 0);
  const nullableCount = (
    day: IncludedHoldingScopeRow[],
    pick: (r: IncludedHoldingScopeRow) => number | null | undefined
  ) => (day.some((r) => pick(r) == null) ? null : count(day, (r) => pick(r) as number));
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => {
      const pnl = day.every(
        (r) => r.costBasis != null && r.realizedPnl != null && r.unrealizedPnl != null
      );
      const anchors = day
        .map((r) => r.oldestAnchorAt)
        .filter((d): d is Date => d instanceof Date)
        .sort((x, y) => x.getTime() - y.getTime());
      return {
        snapshotDate: date,
        totalValue: sum(day, (r) => r.totalValue),
        costBasis: pnl ? sum(day, (r) => r.costBasis as string) : null,
        realizedPnl: pnl ? sum(day, (r) => r.realizedPnl as string) : null,
        unrealizedPnl: pnl ? sum(day, (r) => r.unrealizedPnl as string) : null,
        holdingsWithKnownValue: count(day, (r) => r.holdingsWithKnownValue),
        holdingsTotal: count(day, (r) => r.holdingsTotal),
        holdingsUnpriceable: count(day, (r) => r.holdingsUnpriceable),
        holdingsStalePriced: count(day, (r) => r.holdingsStalePriced),
        holdingsStaleAnchored: nullableCount(day, (r) => r.holdingsStaleAnchored),
        oldestAnchorAt: anchors[0] ?? null,
        holdingsBeforeRecords: nullableCount(day, (r) => r.holdingsBeforeRecords),
        holdingsBasisUnknown: count(day, (r) => r.holdingsBasisUnknown),
        transfersUnreviewed: count(day, (r) => r.transfersUnreviewed),
        anyPartial: day.some(
          (r) =>
            r.coverageQuality === 'partial' ||
            r.holdingsStalePriced > 0 ||
            (r.holdingsStaleAnchored ?? 0) > 0 ||
            (r.holdingsBeforeRecords ?? 0) > 0
        ),
      };
    });
}

/** The production path over per-holding row fixtures. */
export function viaDayTotals(rows: IncludedHoldingScopeRow[]): AggregatedDailyPoint[] {
  return aggregateDailyTotals(sumByDay(rows));
}

export function legacyAggregateIncludedHoldingRows(
  rows: IncludedHoldingScopeRow[]
): AggregatedDailyPoint[] {
  const byDate = new Map<string, IncludedHoldingScopeRow[]>();
  for (const row of rows) {
    const key = String(row.snapshotDate).slice(0, 10);
    const list = byDate.get(key);
    if (list) list.push(row);
    else byDate.set(key, [row]);
  }
  const out: AggregatedDailyPoint[] = [];
  for (const [date, dayRows] of byDate) {
    let totalValue = new Decimal(0);
    let costBasis = new Decimal(0);
    let realizedPnl = new Decimal(0);
    let unrealizedPnl = new Decimal(0);
    let known = 0;
    let total = 0;
    let unpriceable = 0;
    let stalePriced = 0;
    // `null` propagates: if ANY holding row on this day predates the column,
    // the day's count is not knowable, and summing the ones that do have it
    // would report a confident undercount. That is the mistake
    // `holdings_stale_priced` made by taking NOT NULL DEFAULT 0.
    let staleAnchored: number | null = 0;
    // Same null propagation, same reason (SC-317): a day one of whose holding
    // rows predates the column has no knowable count, and summing the rest
    // would report a confident undercount.
    let beforeRecords: number | null = 0;
    let oldestAnchorAt: Date | null = null;
    let basisUnknown = 0;
    let transfersUnreviewed = 0;
    let anyPartial = false;
    let pnlComplete = true;
    for (const r of dayRows) {
      totalValue = totalValue.add(new Decimal(r.totalValue));
      known += r.holdingsWithKnownValue;
      total += r.holdingsTotal;
      unpriceable += r.holdingsUnpriceable;
      stalePriced += r.holdingsStalePriced;
      basisUnknown += r.holdingsBasisUnknown;
      transfersUnreviewed += r.transfersUnreviewed;
      if (r.holdingsStaleAnchored == null) staleAnchored = null;
      else if (staleAnchored !== null) staleAnchored += r.holdingsStaleAnchored;
      if (r.holdingsBeforeRecords == null) beforeRecords = null;
      else if (beforeRecords !== null) beforeRecords += r.holdingsBeforeRecords;
      if (r.oldestAnchorAt && (!oldestAnchorAt || r.oldestAnchorAt < oldestAnchorAt)) {
        oldestAnchorAt = r.oldestAnchorAt;
      }
      // Rows written before SC-151 carry a 0 count and never 'partial', so
      // both readings agree on them; a rebuilt row sets both together.
      //
      // Worth being exact about what that agreement is worth (SC-255): it is
      // two readings of the same DEFAULT, not two measurements that concur.
      // `holdings_stale_priced` is `NOT NULL DEFAULT 0`, so a row predating
      // the column reports a confident zero nobody computed, and this `||`
      // then reads it as "nothing was stale". The day aggregates cleaner than
      // the evidence supports.
      //
      // Left as-is on purpose. The fix is not here — it is the column, and
      // repairing the column needs a cutoff that does not exist: on
      // production every row computed before 2026-08-14 carries 0 in
      // every quality count, and the migration timestamps are hand-authored
      // journal values rather than deploy times. See the block comment above
      // these columns in `schema/portfolio.ts`.
      //
      // `holdingsStaleAnchored` below is nullable for exactly this reason and
      // propagates NULL rather than summing around it, which is the shape
      // these four would need and cannot retroactively get.
      if (
        r.coverageQuality === 'partial' ||
        r.holdingsStalePriced > 0 ||
        (r.holdingsStaleAnchored ?? 0) > 0 ||
        (r.holdingsBeforeRecords ?? 0) > 0
      )
        anyPartial = true;
      if (r.costBasis == null || r.realizedPnl == null || r.unrealizedPnl == null) {
        pnlComplete = false;
      } else {
        costBasis = costBasis.add(new Decimal(r.costBasis));
        realizedPnl = realizedPnl.add(new Decimal(r.realizedPnl));
        unrealizedPnl = unrealizedPnl.add(new Decimal(r.unrealizedPnl));
      }
    }
    const priceable = total - unpriceable;
    let coverageQuality: string;
    if (priceable === 0) {
      // No holding contributed anything priceable to this day, so the
      // sum is zero because nothing was measured. Same call as the
      // rollup's own `upsertScopeRow` — see the note there. A day whose
      // only holdings are unpriceable dust says the same thing.
      coverageQuality = 'unknown';
    } else {
      const ratio = known / priceable;
      if (ratio >= 0.95) coverageQuality = anyPartial ? 'partial' : 'full';
      else if (ratio >= 0.5) coverageQuality = 'estimated';
      else coverageQuality = 'unknown';
    }
    out.push({
      snapshotDate: date,
      totalValue: totalValue.toString(),
      costBasis: pnlComplete ? costBasis.toString() : null,
      realizedPnl: pnlComplete ? realizedPnl.toString() : null,
      unrealizedPnl: pnlComplete ? unrealizedPnl.toString() : null,
      coverageQuality,
      holdingsWithKnownValue: known,
      holdingsTotal: total,
      holdingsUnpriceable: unpriceable,
      holdingsStalePriced: stalePriced,
      holdingsStaleAnchored: staleAnchored,
      oldestAnchorAt: oldestAnchorAt ? (oldestAnchorAt as Date).toISOString() : null,
      holdingsBeforeRecords: beforeRecords,
      holdingsBasisUnknown: basisUnknown,
      transfersUnreviewed,
    });
  }
  out.sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
  return out;
}
