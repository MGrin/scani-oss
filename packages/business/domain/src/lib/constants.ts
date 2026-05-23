// Tokens with `isScamProbability >= SCAM_PROBABILITY_THRESHOLD` are
// filtered out of the dashboard / valuation / list views.
//
// Threshold lowered from 0.45 → 0.35 after analysis showed spam tokens
// (PEPE2, Gas DAO, POINTLESS, …) scoring 0.40 and slipping through.
// `ScamTokenDetectionService` gives 0.40 for tokens with suspicious
// names but no URL — those are still overwhelmingly spam.
export const SCAM_PROBABILITY_THRESHOLD = 0.35;

// Max age of a nearest-neighbour price before the conversion is flagged
// `stale`. The price graph resolves the most recent price at-or-before
// the requested instant with no lower bound, so without this a token
// last priced months ago would silently value the chart at that old
// price. A stale price still contributes to the total (flagging it,
// rather than dropping the holding, avoids fabricating a chart gap on a
// pure data-gap day) — it only downgrades the day's coverage_quality.
//
// Two caps: intraday rows refresh hourly so 7 days of silence is a real
// gap; daily-granularity closes for thin pairs (infrequently-traded
// Kraken pairs, some equities) are legitimately weekly, so 45 days
// avoids false-flagging them.
export const MAX_INTRADAY_PRICE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_DAILY_PRICE_AGE_MS = 45 * 24 * 60 * 60 * 1000;
