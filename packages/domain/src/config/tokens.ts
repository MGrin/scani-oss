/**
 * Token-related configuration constants
 */

/**
 * Scam token probability threshold - tokens with probability above this are filtered out
 * Lowered from 0.45 to 0.35 after analysis showed spam tokens (PEPE2,
 * Gas DAO, POINTLESS, etc.) scoring 0.40 and slipping through. The
 * detection service gives 0.40 for tokens with suspicious names but
 * no URL — these are still overwhelmingly spam.
 */
export const SCAM_PROBABILITY_THRESHOLD = 0.35;
