/**
 * Token-related configuration constants
 */

/**
 * Scam token probability threshold - tokens with probability above this are filtered out
 * Set to 0.45 to catch tokens with URLs/suspicious words while avoiding false positives
 *
 * This threshold is used consistently across the application to filter out scam tokens:
 * - In portfolio valuation calculations
 * - In holdings queries
 * - In any other token-related operations
 */
export const SCAM_PROBABILITY_THRESHOLD = 0.45;
