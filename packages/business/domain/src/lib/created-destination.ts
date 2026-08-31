/**
 * Did this answer have to CREATE the holding it deposited into? (SC-631)
 *
 * ## The bug this exists for
 *
 * Answering an outflow `internal` at an account that tracks no position in the
 * token makes `writeInflow` create a holding, opened at the amount that moved
 * when nobody syncs that account (`openingOf`). Reopening deletes the arrival
 * row — correctly, SC-187 — and used to leave the holding standing: an account
 * showing 250 of a token it held none of, no ledger row explaining it, and the
 * answer that put it there withdrawn. `HoldingsSyncHelper` skips `manual`
 * rows, so no sync may ever correct that figure, and being invisible to the
 * sync the row is not found either — the next pass creates a SECOND holding
 * for the same account and token.
 *
 * ## Why the marker is a value on the arrival row and not a column on the
 * holding
 *
 * The fact has exactly the lifetime of the answer. It is written by the one
 * writer that can know it, read by the one reader that needs it, and deleted
 * with the row it describes — so it cannot go stale, be re-answered into a
 * lie, or outlive the holding it is about. A column on `holdings` would
 * survive all three.
 *
 * ## Why `false` is written explicitly, and why that is the whole point
 *
 * `writeInflow` records the marker on EVERY branch — `true` where it created
 * the destination, `false` where it reused one that already existed. Nothing
 * is left to absence.
 *
 * That is what makes the three states distinguishable, and it is the
 * difference between this fix and a fix-shaped one. A reader looking at a
 * nullable field can tell "no" from "yes"; it cannot tell "no" from "nobody
 * ever wrote this". Here it can:
 *
 * - `created`    — this answer opened the destination. Undo it.
 * - `reused`     — the destination already existed. Positively asserted, not
 *                  inferred. Whether the answer moved that destination's
 *                  balance is a SEPARATE marker — see
 *                  `readMovedDestinationAnchor` below, which SC-856 added
 *                  precisely because this one stopped being able to answer it.
 * - `unrecorded` — the key is absent or is not a boolean. Nobody said either
 *                  way, which is what every arrival row written before SC-631
 *                  looks like. **Take no action**: deleting a holding on an
 *                  absent marker is a guess about somebody's money, and the
 *                  status quo for those rows is the bug, not a loss.
 *
 * The failure mode of the marker never being written is therefore a visible,
 * safe no-op rather than a silent one — the same thing `arrival` could not
 * offer when production held zero `user_confirmed` rows and nobody could tell
 * whether the writers had never run or the value had not survived.
 *
 * Falsifier, one query, no code:
 *
 *     select source_metadata->>'createdDestinationHolding' as marker, count(*)
 *       from holding_transactions
 *      where source = 'transfer-review'
 *      group by 1;
 *
 * Rows written since SC-631 read `true` or `false`. A `null` bucket is either
 * a pre-SC-631 row or a writer that stopped setting it, and `created_at`
 * separates those two in the same query.
 */

/** The one place the key is spelled. `source_metadata` is schemaless jsonb, so
 *  a typo at either end is invisible — the writer and the reader below share
 *  this constant rather than each carrying a string literal. Not exported:
 *  nothing outside this module should be reading the key, only the two
 *  functions that understand what its absence means. */
const CREATED_DESTINATION_KEY = 'createdDestinationHolding';

/** The second marker, on the same row and spelled once for the same reason
 *  (SC-856). See `readMovedDestinationAnchor` for what the three states mean
 *  and why this is not derivable from `CREATED_DESTINATION_KEY`. */
const MOVED_ANCHOR_KEY = 'movedDestinationAnchor';

export type CreatedDestination = 'created' | 'reused' | 'unrecorded';

export type MovedDestinationAnchor = 'moved' | 'not_moved' | 'unrecorded';

/** The `source_metadata` an arrival row carries. Both markers are required, so
 *  a create path that forgets one does not compile — there is no default
 *  anywhere that would let the omission read as a valid answer. */
export function arrivalMetadata(opts: {
  outflowTransactionId: string;
  createdDestination: boolean;
  movedDestinationAnchor: boolean;
}): Record<string, unknown> {
  return {
    outflowTransactionId: opts.outflowTransactionId,
    [CREATED_DESTINATION_KEY]: opts.createdDestination,
    [MOVED_ANCHOR_KEY]: opts.movedDestinationAnchor,
  };
}

/**
 * What this arrival row says about its destination.
 *
 * Anything that is not literally `true` or `false` reads as `unrecorded` —
 * a string `"true"`, a number, a null. The reader acts on a boolean or it
 * does not act.
 */
export function readCreatedDestination(sourceMetadata: unknown): CreatedDestination {
  if (typeof sourceMetadata !== 'object' || sourceMetadata === null) return 'unrecorded';
  const value = (sourceMetadata as Record<string, unknown>)[CREATED_DESTINATION_KEY];
  if (value === true) return 'created';
  if (value === false) return 'reused';
  return 'unrecorded';
}

/**
 * Did this answer MOVE the destination holding's balance? (SC-856)
 *
 * ## Why it is a second marker rather than a reading of the first
 *
 * `readCreatedDestination` answers "did this answer open the row", and until
 * SC-856 that also answered "did this answer move a balance": `created` opened
 * one at the moved amount, `reused` touched none. `writeInflow` now moves the
 * anchor of a REUSED destination that no balance sync will ever correct, so
 * one `reused` row moved money and another did not, and the first marker can
 * no longer tell them apart.
 *
 * ## Why the fact is recorded and not re-derived at reopen time
 *
 * The predicate is "will a sync write this row" — a question about the account's
 * credentials and the holding's `source`, both of which move between answering
 * and reopening. Connect an exchange after answering and re-deriving says *the
 * anchor was not moved* about a row that moved it, so `reopen` leaves the
 * destination permanently 2,000 up. Disconnect one and it says the opposite,
 * and `reopen` takes 2,000 off a balance the answer never added. Neither
 * failure is visible; both are money. The write knew, so the write says.
 *
 * ## The three states, and why `not_moved` is written explicitly
 *
 * - `moved`      — `reopen` must put the anchor back.
 * - `not_moved`  — the destination's balance is somebody else's to state, and
 *                  this answer left it alone. `reopen` must NOT touch it.
 * - `unrecorded` — nobody said. Every arrival row written before SC-856 looks
 *                  like this, and every one of them left the anchor alone —
 *                  but `unrecorded` is not read as `not_moved` on purpose. The
 *                  two happen to prescribe the same action today, and a reader
 *                  that collapsed them would silently start reversing anchors
 *                  the day a writer forgot the key. **Take no action.**
 *
 * Falsifier, one query, no code:
 *
 *     select source_metadata->>'movedDestinationAnchor' as marker, count(*)
 *       from holding_transactions
 *      where source = 'transfer-review'
 *      group by 1;
 *
 * Rows written since SC-856 read `true` or `false`. A `null` bucket is a
 * pre-SC-856 row or a writer that stopped setting it; `created_at` separates
 * those two in the same query.
 */
export function readMovedDestinationAnchor(sourceMetadata: unknown): MovedDestinationAnchor {
  if (typeof sourceMetadata !== 'object' || sourceMetadata === null) return 'unrecorded';
  const value = (sourceMetadata as Record<string, unknown>)[MOVED_ANCHOR_KEY];
  if (value === true) return 'moved';
  if (value === false) return 'not_moved';
  return 'unrecorded';
}
