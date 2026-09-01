/**
 * The `source` values a PERSON authored, and the sets derived from them.
 *
 * ## Why they live in a leaf of their own (SC-902)
 *
 * These four values are read by both ends of the ledger — the writer that
 * stamps a row and the queries that must exclude one — and the two ends are
 * on opposite sides of the dependency graph. Declaring them beside either end
 * makes the other end import it, and until SC-902 that edge closed a cycle:
 *
 *     HoldingTransactionRepository -> lib/transfer-matching
 *       -> ManualBalanceEditService -> HoldingTransactionRepository
 *
 * A cycle of `const` declarations does not fail where it is written. It fails
 * wherever the runtime happens to enter it: `PERSON_AUTHORED_SOURCES` read
 * `MANUAL_EDIT_FLOW_SOURCE` in its temporal dead zone and threw
 * `Cannot access 'MANUAL_EDIT_FLOW_SOURCE' before initialization` — for one
 * entry point and not the others, so the full suite was green and
 * `bun test <one file>` could not load at all.
 *
 * This module imports nothing. That is the property that fixes it, and it is
 * the only reason the file exists: anything added here that needs an import
 * puts the cycle back.
 */

/**
 * The `source` a row carries when a person typed a TRANSACTION (SC-611).
 *
 * Declared once and imported by both the writer and the readers, rather than
 * repeated as a literal. It was already load-bearing as a literal in two
 * places inside the API router — the insert and the mutability gate that keeps
 * ingester-sourced rows immutable — and SC-611 makes it load-bearing in a
 * third, a long way from either.
 */
export const USER_ENTERED_SOURCE = 'user-entered';

/**
 * The two `source` values `ManualBalanceEditService` writes, and nothing else
 * writes.
 *
 * Separate from `'user-entered'` — which is a person typing a TRANSACTION —
 * because these rows describe an edit to a BALANCE that we then explained.
 * The distinction is what lets an audit ask "what did we synthesize" without
 * catching every hand-entered trade in the product.
 */
export const MANUAL_EDIT_FLOW_SOURCE = 'user-balance-edit';
export const MANUAL_EDIT_CORRECTION_SOURCE = 'user-balance-correction';

/**
 * Inflow sources the nightly matcher may NOT claim on its own (SC-611).
 *
 * ## The hole
 *
 * `transfer_review` is outflow-only, so an inflow has nowhere to record that a
 * person had a view about it. The matcher's outflow query has always refused
 * an answered row — *"already answered is not a candidate, whatever they
 * answered"* — and its inflow query gated on `transfer_group_id IS NULL`
 * alone, because there was no column for it to read. So a deposit somebody
 * typed could be claimed as the arrival leg of an unrelated outflow, and
 * `CostBasisService` would carry lots across a movement that never happened.
 *
 * ## Why the source is the right marker and not a new column
 *
 * These two values are true **by construction of a person having authored the
 * row**: no importer writes either. `user-entered` is set only by the API's
 * transaction router, `user-balance-edit` only by `ManualBalanceEditService`
 * on `cause: 'flow'`. And it is a DECLARED contract rather than an incidental
 * value — the router already gates row mutability on it, in code that predates
 * this — so nothing here is a rule somebody could rename their way out of
 * without noticing.
 *
 * A `cause: 'correction'` edit needs no entry: it writes `kind = 'correction'`,
 * which is not in `INFLOW_KINDS`, so the matcher already cannot see it.
 *
 * ## Why this is NOT in `candidatePairClass`
 *
 * That predicate answers *"are these two rows a plausible pair?"* — a fact
 * about the rows, which every caller must agree on, and SC-347 moved the
 * same-holding guard into it for exactly that reason. This asks *"may the
 * nightly job decide it on its own?"*, which is a question about AUTHORITY and
 * has a different answer for a person than for a cron. The review queue still
 * offers a hand-entered deposit as an arrival, and a reader who picks one is
 * telling us something the matcher could not know.
 *
 * Measured on production 2026-08-26 before the fix: a small minority of
 * inflows are person-authored and 0 groups had ever been damaged, against a
 * non-empty control of matcher-made groups. Prevention, with no repair owed.
 */
export const PERSON_AUTHORED_SOURCES = [USER_ENTERED_SOURCE, MANUAL_EDIT_FLOW_SOURCE] as const;

/**
 * The same two values under the name the matcher's inflow query reads them by.
 *
 * DERIVED rather than repeated: authorship is a fact about the row and has no
 * direction, while "inflow" is a fact about the one caller. Writing the list
 * out twice would let a third person-authored source be added to whichever
 * name the next reader happened to open — and the failure mode is silent on
 * both sides, since each list is individually plausible (SC-858).
 */
export const PERSON_AUTHORED_INFLOW_SOURCES = PERSON_AUTHORED_SOURCES;
