import { type SQL, sql } from 'drizzle-orm';
import { SCAM_PROBABILITY_THRESHOLD } from './constants';
import { notScamFor } from './scam-verdict';

// Canonical rule for whether a holding contributes to a portfolio
// total. The dashboard headline (PortfolioValuationService) and the
// historical chart's read path both apply this rule so the two
// reconcile — the chart used to include hidden / inactive / scam
// holdings the dashboard excluded, so its latest point never matched
// the headline.
//
// The fields are kept minimal so any holding / token row shape (or a
// join projection) satisfies the predicate.

export interface InclusionHolding {
  isHidden: boolean;
  isActive: boolean;
  hiddenBy?: 'user' | 'auto' | null;
}

export interface InclusionToken {
  isScamProbability: number;
}

// The holding half of the rule. A holding its OWNER hid counts nowhere; one
// the closed-position sweep hid (`hiddenBy = 'auto'`) still counts in value
// history, PnL, returns and flows (mgrin, 2026-10-02, SC-1486). A hidden
// holding with no `hiddenBy` is the owner's, which is how every hidden holding
// was read before the column existed.
export function holdingCountsInTotal(holding: InclusionHolding): boolean {
  if (holding.isHidden && holding.hiddenBy !== 'auto') return false;
  return holding.isActive;
}

// The holdings the rollup lists for a user: every one a total counts, and the
// visible ones it does not, which keep a row of their own. Defined on the rule
// above so the rollup can never preload fewer holdings than the valuation
// prices: a sweep-hidden one it left out was costed from its balance readings
// alone, with its ledger never read (SC-1546).
export function holdingIsRolledUp(holding: InclusionHolding): boolean {
  return !holding.isHidden || holdingCountsInTotal(holding);
}

// True when a holding should count toward a portfolio total. Owner-hidden
// holdings, inactive holdings, and scam tokens never count.
//
// NOTE: `includedInTotalSql` below is the same rule for SQL readers, and
// `tests/lib/holding-inclusion.test.ts` holds the two to one answer.
export function isIncludedInTotal(holding: InclusionHolding, token: InclusionToken): boolean {
  if (!holdingCountsInTotal(holding)) return false;
  if (token.isScamProbability >= SCAM_PROBABILITY_THRESHOLD) return false;
  return true;
}

// The same rule as a WHERE clause over `holdings` joined to `tokens`, for every
// reader that filters in SQL: the value history, the returns series and the
// external flows. One fragment, so they cannot drift apart again.
export function includedInTotalSql(holdings = 'holdings', tokens = 'tokens'): SQL {
  const h = sql.identifier(holdings);
  return sql`((${h}.is_hidden = false OR ${h}.hidden_by = 'auto') AND ${h}.is_active = true AND ${notScamFor(holdings, tokens)})`;
}
