import type { PortfolioValueDaily } from '@scani/db/schema';
import {
  type IncludedHoldingScopeRow,
  PortfolioValueDailyRepository,
} from '@scani/domain/repositories';
import Decimal from 'decimal.js';
import { Container } from 'typedi';

/**
 * **The** user-wide daily net worth. One definition, because there used to be
 * two and they disagreed in files the user keeps (SC-98).
 *
 * The home chart's export and the whole-account workbook were computed from
 * different tables. `getNetWorthSeries` without a scope summed the
 * inclusion-filtered **per-holding** rollup rows; `exports.everything` read the
 * pre-aggregated `scope_kind = 'user'` row straight out of
 * `portfolio_value_daily`. Those are two independent measurements, and whenever
 * the rollup is partially complete — which is its normal state mid-run — they
 * differ. The user then had two files from the same minute stating different
 * net worths for the same date, with nothing in either saying they were
 * measured differently.
 *
 * A wrong figure on a screen is transient. A wrong figure in a spreadsheet is
 * evidence, and two of our own exports contradicting each other means neither
 * can be trusted even when one of them is right. So there is now exactly one
 * function that answers "what was this user worth on this day", every caller
 * uses it, and `tests/lib/net-worth-series.test.ts` asserts the two export
 * paths agree — that invariant is the deliverable, not any particular number.
 *
 * **Which of the two survived, and why.** The per-holding aggregate. It applies
 * the inclusion contract — hidden, inactive and scam-flagged holdings dropped —
 * so its latest point reconciles with the dashboard headline. The
 * `scope_kind = 'user'` row does not, which is what let the workbook print a
 * figure the screen never showed.
 */

// One user-wide daily chart point. Both the net-worth and PnL series
// downsample + render from this shape, sourced either from the
// inclusion-filtered per-holding rollup rows (user-wide) or the
// pre-aggregated per-entity rollup row (scoped).
export interface AggregatedDailyPoint {
  snapshotDate: string;
  totalValue: string;
  costBasis: string | null;
  realizedPnl: string | null;
  unrealizedPnl: string | null;
  coverageQuality: string;
  holdingsWithKnownValue: number;
  /** Every holding in scope that day, unpriceable dust included. */
  holdingsTotal: number;
  /**
   * Of `holdingsTotal`, the ones nothing can price — never quoted once and
   * still in an unpriceable cooldown. Coverage is
   * `holdingsWithKnownValue / (holdingsTotal - holdingsUnpriceable)`, so a
   * wallet full of airdrop spam no longer reads as a pricing failure
   * (SC-146).
   */
  holdingsUnpriceable: number;
  /**
   * Of `holdingsWithKnownValue`, how many were priced from a quote older than
   * the freshness window (SC-151). The value is in `totalValue` either way —
   * an old price is still a measurement — but a reader who is not told cannot
   * tell this figure from one quoted the same morning, and the sample that
   * started this ticket was 96 days old.
   */
  holdingsStalePriced: number;
  /**
   * Of `holdingsWithKnownValue`, how many had their BALANCE extrapolated
   * forward from an observation before this date, because nothing at or
   * after it existed to anchor on (SC-249).
   *
   * The sibling of `holdingsStalePriced` and not the same thing: a stale
   * price means the quantity is known and its valuation is old; a stale
   * anchor means the quantity itself is a projection. Both land the day on
   * `'partial'`, which is why one number could never tell a reader which
   * happened — or what to do about it, since the remedies differ.
   *
   * `null` means NOT RECORDED: the row was computed before the rollup
   * carried provenance. Distinct from `0`, which means counted and none.
   */
  holdingsStaleAnchored: number | null;
  /**
   * The oldest anchor behind this day's total — the far end of its weakest
   * reconstruction (SC-249). `null` when nothing was backward-anchored, or
   * when the row predates the column; `holdingsStaleAnchored` separates
   * those (`0` vs `null`).
   *
   * This is what ranks two `'partial'` days. Production holds both extremes
   * at once: one holding anchored 54 seconds back, another 71 days back.
   */
  oldestAnchorAt: string | null;
  /**
   * Of `holdingsWithKnownValue`, how many were valued on a date BEFORE the
   * holding's own first evidence, so the balance is projected backward past
   * anything that records it (SC-252, counted since SC-317).
   *
   * The third member of the family, and separate from `holdingsStaleAnchored`
   * for the reason that one is separate from `holdingsStalePriced`: that is
   * projected FORWARD from a stale observation, this is projected BACKWARD
   * past first evidence, and the remedies differ — sync the source, versus
   * import older history or accept there is none.
   *
   * `null` means NOT RECORDED: the row predates the column. Distinct from
   * `0`, which means counted and none.
   */
  holdingsBeforeRecords: number | null;
  /**
   * Of `holdingsTotal`, how many carry a cost basis we do not know (SC-149) —
   * truncated provider history, a leg priced beyond the staleness window, an
   * inflow nothing could value, or no acquisition on record at all. Reading
   * `realizedPnl` without it is reading a gain whose cost side is partly
   * missing, and missing cost only ever makes the gain look larger.
   */
  holdingsBasisUnknown: number;
  /**
   * Outflows on that day or before whose lots left with no gain booked,
   * because only a person's `left_control` answer realizes one (SC-150).
   * The only count here whose error runs DOWNWARD: where one of these is a
   * genuine off-platform sale, `realizedPnl` is short by it (SC-160).
   *
   * A count of transactions rather than of holdings, and only of the rows
   * the review queue holds — so the caveat and the page it sends the reader
   * to agree on the number, and answering them all takes it to zero.
   */
  transfersUnreviewed: number;
}

// Map a pre-aggregated rollup row (scoped series path) to the shared
// daily-point shape.
export function toAggregatedDaily(row: PortfolioValueDaily): AggregatedDailyPoint {
  return {
    snapshotDate: String(row.snapshotDate).slice(0, 10),
    totalValue: row.totalValue,
    costBasis: row.costBasis,
    realizedPnl: row.realizedPnl,
    unrealizedPnl: row.unrealizedPnl,
    coverageQuality: row.coverageQuality,
    holdingsWithKnownValue: row.holdingsWithKnownValue,
    holdingsTotal: row.holdingsTotal,
    holdingsUnpriceable: row.holdingsUnpriceable,
    holdingsStalePriced: row.holdingsStalePriced,
    holdingsStaleAnchored: row.holdingsStaleAnchored ?? null,
    oldestAnchorAt: row.oldestAnchorAt ? row.oldestAnchorAt.toISOString() : null,
    holdingsBeforeRecords: row.holdingsBeforeRecords ?? null,
    holdingsBasisUnknown: row.holdingsBasisUnknown,
    transfersUnreviewed: row.transfersUnreviewed,
  };
}

// Group inclusion-filtered per-holding rollup rows into one user-wide
// point per date. coverage_quality is re-derived from the known/total
// ratio with the rollup's thresholds; a fully-priced day stays
// 'partial' when any holding used a stale anchor/price. The day's PnL
// is null unless every holding row carries cost columns (pre-rebuild
// rows may not), since a partial sum would be misleading.
export function aggregateIncludedHoldingRows(
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

/**
 * Whether a day's total is a measurement at all — the server-side twin of the
 * frontend's `hasKnownCoverage` (`v3/lib/home.ts`), and the fix for SC-95.
 *
 * Zero holdings priced means the day's `totalValue` of 0 is the absence of an
 * answer, not the answer zero. SC-66 established that for the chart, which
 * filters these out before plotting; the export was a second consumer that
 * never received the guard and wrote `2026-08-14,0,unknown,0,0` into a file
 * whose reader has no way to tell that `0` apart from a real one. A number in a
 * spreadsheet gets summed and averaged.
 *
 * The guard lives here now rather than in either consumer, so a third one
 * cannot be written without it.
 */
export function hasKnownCoverage(point: Pick<AggregatedDailyPoint, 'holdingsWithKnownValue'>) {
  return point.holdingsWithKnownValue > 0;
}

/**
 * Every day this user's portfolio was actually measured, in ascending date
 * order. Uncovered days are absent rather than zero.
 */
export async function userNetWorthDaily(
  userId: string,
  baseCurrencyId: string,
  from: Date,
  to: Date
): Promise<AggregatedDailyPoint[]> {
  const repo = Container.get(PortfolioValueDailyRepository);
  const rows = await repo.findIncludedHoldingScopeRange(userId, baseCurrencyId, from, to);
  return aggregateIncludedHoldingRows(rows).filter(hasKnownCoverage);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
}

/**
 * The days inside the window we have no measurement for — the *absence*, named,
 * so a chart can draw it (SC-115).
 *
 * `userNetWorthDaily` drops uncovered days, which is right for a file: a `0` in
 * a spreadsheet gets summed. It is not enough for a chart. The home chart plots
 * a **category** axis, one slot per returned point, so a dropped day is not a
 * gap in the picture — it is a day that never existed, and the curve joins the
 * points either side of it with a straight line. On an account whose rollup
 * stopped four days ago that line is drawn from the last real measurement to
 * today's live total: a rise the reader never had, presented exactly like the
 * measured ones beside it. Before SC-98 the uncovered rows still reached the
 * client and the curve broke over them; filtering them at the source closed the
 * export hole and quietly closed the break too.
 *
 * So the omission is reported rather than implied. Only from the **first**
 * measured day: history that predates the account is not a gap in what we know,
 * it is simply history nobody had, and drawing it as a hole would compress the
 * real data into a corner of the chart.
 */
export function unmeasuredDates(measuredDates: readonly string[], through: string): string[] {
  const first = measuredDates[0];
  if (!first) return [];
  const measured = new Set(measuredDates);
  const gaps: string[] = [];
  for (let day = nextDay(first); day <= through; day = nextDay(day)) {
    if (!measured.has(day)) gaps.push(day);
  }
  return gaps;
}

/**
 * One day of net-worth history as both exports write it.
 *
 * The shape is shared for the same reason the source is: the home chart's CSV
 * and the account workbook are two files a reader will lay side by side, and
 * a field renamed or a date formatted differently in one of them re-opens
 * SC-98 in a way no type error would catch.
 */
export interface NetWorthHistoryRow {
  date: string;
  totalValue: string;
  coverageQuality: string;
  holdingsWithKnownValue: number;
  holdingsTotal: number;
  holdingsUnpriceable: number;
  /** See AggregatedDailyPoint — the two columns that keep a spreadsheet honest. */
  holdingsStalePriced: number;
  /**
   * SC-249. Carried into both exports for the same reason
   * `holdingsStalePriced` is: a spreadsheet the reader lays beside the chart
   * must be able to say which figures rest on a projected quantity.
   * `null` = the row predates the column, not zero.
   */
  holdingsStaleAnchored: number | null;
  /** SC-249. ISO timestamp of the oldest anchor behind the day, or null. */
  oldestAnchorAt: string | null;
  /**
   * SC-317. Carried beside `holdingsStaleAnchored` because the two are only
   * legible together: one says a quantity was projected forward from a stale
   * observation, the other that it was projected backward past anything
   * recording the holding at all. A file carrying one and not the other lets
   * a reader attribute a 'partial' day to the wrong cause.
   * `null` = the row predates the column, not zero.
   */
  holdingsBeforeRecords: number | null;
  holdingsBasisUnknown: number;
  // `transfersUnreviewed` is deliberately NOT here. It qualifies realized
  // PnL, and neither file this shape writes contains a PnL column — a count
  // that explains a figure the reader cannot see in the same file is a
  // column they can only misread. It rides the PnL series instead. Add it
  // here the day either export grows a realized-PnL column.
}

export function toNetWorthHistoryRow(point: AggregatedDailyPoint): NetWorthHistoryRow {
  return {
    date: point.snapshotDate,
    totalValue: point.totalValue,
    coverageQuality: point.coverageQuality,
    holdingsWithKnownValue: point.holdingsWithKnownValue,
    holdingsTotal: point.holdingsTotal,
    holdingsUnpriceable: point.holdingsUnpriceable,
    holdingsStalePriced: point.holdingsStalePriced,
    holdingsStaleAnchored: point.holdingsStaleAnchored,
    oldestAnchorAt: point.oldestAnchorAt,
    holdingsBeforeRecords: point.holdingsBeforeRecords,
    holdingsBasisUnknown: point.holdingsBasisUnknown,
  };
}
