import type { CoverageQuality } from '@scani/db/schema';

// The share of a day's priceable holdings that carry a value:
//   full      = >= 95% priced, and no holding's value is degraded
//   partial   = >= 95% priced, and some holding's value rests on a stale price,
//               a backward balance anchor or a day before its own records
//   estimated = 50%–95% priced
//   unknown   = < 50% priced, or nothing priceable at all
//
// The 5% slack was originally the whole defence against wallet-airdrop dust,
// and it was not enough: an account with 14 spam tokens out of 69 sat
// permanently at 80%, i.e. 'estimated', while every asset the user actually
// owns was priced (SC-146). Unpriceable dust leaves the denominator outright,
// and the slack covers what it was always meant to: a genuinely priceable token
// missing today's quote.
//
// One rule for the valuation, the rollup's scope rows and the series endpoint
// (D-13). It was three copies, and SC-249 and SC-252 were each a copy that had
// not been taught a downgrade the others applied.
const FULL = 0.95;
const PARTIAL = 0.5;

export function coverageQualityOf(counts: {
  withKnownValue: number;
  total: number;
  unpriceable: number;
  degraded: boolean;
}): CoverageQuality {
  const priceable = counts.total - counts.unpriceable;
  if (priceable === 0) return 'unknown';
  const ratio = counts.withKnownValue / priceable;
  if (ratio >= FULL) return counts.degraded ? 'partial' : 'full';
  return ratio >= PARTIAL ? 'estimated' : 'unknown';
}
