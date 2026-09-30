import Decimal from 'decimal.js';
import type { TwrPeriod, ValuationPoint } from './twr';

// Share of today's value a day's capital must reach before its returns count
// (SC-1439). Measured on mgrin's history: 10%, 20% and 50% all pick the same
// day, and 5% lands inside the stretch this exists to skip.
const MATERIAL_SHARE = new Decimal('0.1');

/**
 * Index of the first point from which every point's capital stays a material
 * part of today's value.
 *
 * Time-weighted return gives every day equal weight, so a window that opens
 * on a few hundred pounds of volatile tokens and later receives the bulk of
 * the portfolio is decided by those early days. A point's capital is its value
 * carried forward by every later sub-period's growth: pure growth keeps it at
 * all of today's value and a crash only raises its share, so neither is ever
 * trimmed. Only money added later, or withdrawn down to a tiny base, can make
 * a day immaterial.
 */
export function materialStartIndex(
  points: readonly ValuationPoint[],
  periods: readonly TwrPeriod[]
): number {
  const last = points.at(-1);
  if (!last || last.value.lte(0)) return 0;
  const threshold = last.value.mul(MATERIAL_SHARE);

  const growthToEnd: Decimal[] = new Array(points.length);
  growthToEnd[points.length - 1] = new Decimal(1);
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const period = periods[i];
    const factor =
      period?.measured && period.return !== null
        ? new Decimal(period.return).add(1)
        : new Decimal(1);
    growthToEnd[i] = (growthToEnd[i + 1] as Decimal).mul(factor);
  }

  // The start must stay material from then on: a material day that is then
  // withdrawn down to a tiny base would let that base decide the figure.
  let index = 0;
  points.forEach((point, i) => {
    if (point.value.mul(growthToEnd[i] as Decimal).lt(threshold)) index = i + 1;
  });
  // A stretch that measured nothing, such as a scope funded from zero, cannot
  // have decided the figure, and trimming it would only drop its funding flow.
  const decided = periods.slice(0, index).some((period) => period.measured);
  return index > 0 && decided ? index : 0;
}
