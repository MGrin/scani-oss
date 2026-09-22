/**
 * Whether a holding belongs under "Holdings with no coverage row" (SC-1252).
 *
 * A coverage row records how far back an import's transaction history
 * reached. A holding with no transactions — every hand-typed one — has
 * nothing for a row to describe, and `historyCompletenessOf` already reads
 * its absence as `unrecorded` rather than as a defect. Flagging it put a
 * "Flagged" line in front of every newcomer whose first holding was typed in.
 * The population worth flagging is the one SC-307 named: a ledger written
 * with no coverage beside it.
 */
export function lacksCoverage(row: { has_transactions: boolean; has_coverage: boolean }): boolean {
  return row.has_transactions && !row.has_coverage;
}
