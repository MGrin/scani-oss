// Tokens with `isScamProbability >= SCAM_PROBABILITY_THRESHOLD` are
// filtered out of the dashboard / valuation / list views.
//
// Threshold lowered from 0.45 → 0.35 after analysis showed spam tokens
// (PEPE2, Gas DAO, POINTLESS, …) scoring 0.40 and slipping through.
// `ScamTokenDetectionService` gives 0.40 for tokens with suspicious
// names but no URL — those are still overwhelmingly spam.
export const SCAM_PROBABILITY_THRESHOLD = 0.35;
