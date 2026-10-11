import Decimal from 'decimal.js';

/** One holding's rollup on one day: the shape `findIncludedHoldingScopeRange` returns. */
export interface BreakdownRow {
  snapshotDate: string;
  holdingId: string;
  totalValue: string;
  realizedPnl: string | null;
  unrealizedPnl: string | null;
}

export interface BreakdownHolding {
  symbol: string;
  accountName: string;
  accountType: { code: string; name: string } | null;
}

export interface BreakdownChange {
  start: string;
  end: string;
  change: string;
}

export interface PeriodBreakdown {
  startDate: string | null;
  endDate: string | null;
  total: BreakdownChange;
  /** `code` and `name` are null for a holding whose account type is unknown. */
  byAccountType: (BreakdownChange & { code: string | null; name: string | null })[];
  topMovers: (BreakdownChange & {
    holdingId: string;
    symbol: string | null;
    accountName: string | null;
  })[];
  topPnl: {
    holdingId: string;
    symbol: string | null;
    accountName: string | null;
    realized: string;
    unrealized: string;
    total: string;
  }[];
}

const TOP = 5;
const ZERO = new Decimal(0);

function change(start: Decimal, end: Decimal): BreakdownChange {
  return { start: start.toString(), end: end.toString(), change: end.sub(start).toString() };
}

/** Biggest change first, up or down; on a tie the gain leads. */
function bySize(a: Decimal, b: Decimal): number {
  return b.abs().comparedTo(a.abs()) || b.comparedTo(a);
}

/**
 * The Home chart peek's breakdown of a period (SC-1692). It compares the first
 * and last days of the same rows the user-wide series sums, so every part adds
 * up to the change the chart shows: a holding with no row on one of those days
 * counts as zero there. PnL is the change in cumulative realized and
 * unrealized, the way the hero reads it, and a holding whose PnL is unknown on
 * either day is left out of top PnL rather than counted as zero.
 */
export function periodBreakdown(
  rows: readonly BreakdownRow[],
  holdings: ReadonlyMap<string, BreakdownHolding>
): PeriodBreakdown {
  if (rows.length === 0) {
    return {
      startDate: null,
      endDate: null,
      total: change(ZERO, ZERO),
      byAccountType: [],
      topMovers: [],
      topPnl: [],
    };
  }

  let startDate = rows[0]!.snapshotDate;
  let endDate = startDate;
  for (const r of rows) {
    if (r.snapshotDate < startDate) startDate = r.snapshotDate;
    if (r.snapshotDate > endDate) endDate = r.snapshotDate;
  }

  const first = new Map<string, BreakdownRow>();
  const last = new Map<string, BreakdownRow>();
  for (const r of rows) {
    if (r.snapshotDate === startDate) first.set(r.holdingId, r);
    if (r.snapshotDate === endDate) last.set(r.holdingId, r);
  }
  const holdingIds = [...new Set([...first.keys(), ...last.keys()])];

  const valueAt = (r: BreakdownRow | undefined) => (r ? new Decimal(r.totalValue) : ZERO);
  const types = new Map<
    string,
    { code: string | null; name: string | null; start: Decimal; end: Decimal }
  >();
  const movers: PeriodBreakdown['topMovers'] = [];
  const pnl: PeriodBreakdown['topPnl'] = [];
  let totalStart = ZERO;
  let totalEnd = ZERO;

  for (const holdingId of holdingIds) {
    const holding = holdings.get(holdingId);
    const symbol = holding?.symbol ?? null;
    const accountName = holding?.accountName ?? null;
    const startRow = first.get(holdingId);
    const endRow = last.get(holdingId);
    const start = valueAt(startRow);
    const end = valueAt(endRow);
    totalStart = totalStart.add(start);
    totalEnd = totalEnd.add(end);

    const typeKey = holding?.accountType?.code ?? '';
    const type = types.get(typeKey) ?? {
      code: holding?.accountType?.code ?? null,
      name: holding?.accountType?.name ?? null,
      start: ZERO,
      end: ZERO,
    };
    types.set(typeKey, { ...type, start: type.start.add(start), end: type.end.add(end) });

    if (!end.eq(start)) movers.push({ holdingId, symbol, accountName, ...change(start, end) });

    const realized = pnlChange(startRow?.realizedPnl, endRow?.realizedPnl, startRow, endRow);
    const unrealized = pnlChange(startRow?.unrealizedPnl, endRow?.unrealizedPnl, startRow, endRow);
    if (realized && unrealized) {
      const total = realized.add(unrealized);
      if (!total.isZero()) {
        pnl.push({
          holdingId,
          symbol,
          accountName,
          realized: realized.toString(),
          unrealized: unrealized.toString(),
          total: total.toString(),
        });
      }
    }
  }

  return {
    startDate,
    endDate,
    total: change(totalStart, totalEnd),
    byAccountType: [...types.values()]
      .map(({ code, name, start, end }) => ({ code, name, ...change(start, end) }))
      .sort((a, b) => bySize(new Decimal(a.change), new Decimal(b.change))),
    topMovers: movers
      .sort((a, b) => bySize(new Decimal(a.change), new Decimal(b.change)))
      .slice(0, TOP),
    topPnl: pnl.sort((a, b) => bySize(new Decimal(a.total), new Decimal(b.total))).slice(0, TOP),
  };
}

/** A missing row is zero; a row whose value is unknown makes the change unknown. */
function pnlChange(
  startValue: string | null | undefined,
  endValue: string | null | undefined,
  startRow: BreakdownRow | undefined,
  endRow: BreakdownRow | undefined
): Decimal | null {
  if ((startRow && startValue == null) || (endRow && endValue == null)) return null;
  return new Decimal(endValue ?? 0).sub(startValue ?? 0);
}
