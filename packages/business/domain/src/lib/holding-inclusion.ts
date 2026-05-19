import { SCAM_PROBABILITY_THRESHOLD } from './constants';

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
}

export interface InclusionToken {
  isScamProbability: number;
}

// True when a holding should count toward a portfolio total. Hidden
// holdings, inactive holdings, and scam tokens never count.
//
// NOTE: the historical-chart read path
// (PortfolioValueDailyRepository.findIncludedHoldingScopeRange) applies
// the SAME three conditions in SQL — keep the two in sync.
export function isIncludedInTotal(holding: InclusionHolding, token: InclusionToken): boolean {
  if (holding.isHidden) return false;
  if (!holding.isActive) return false;
  if (token.isScamProbability >= SCAM_PROBABILITY_THRESHOLD) return false;
  return true;
}
