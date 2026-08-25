/**
 * Telling a transfer the OWNER DECLARED from one the QUEUE answered (SC-618).
 *
 * ## Why this distinction has to exist at all
 *
 * Two writers reach `transfer_group_id` and they have opposite requirements
 * about balances, deliberately (mgrin, 2026-08-25 — an intent flag on one
 * shared function was rejected):
 *
 * - `TransferReviewService.writeInflow`, the queue, **never moves an existing
 *   destination's anchor**. The outflow came from an import and whatever
 *   produced the destination's balance already observed the arrival, so moving
 *   it would count the money twice.
 * - `UpdateHoldingUseCase.moveDeclaredTransfer` and
 *   `RecordHoldingMovementUseCase`, the declared paths, **move both anchors**,
 *   because the owner is the only source of truth for both sides and only one
 *   of them has moved.
 *
 * Undoing an answer therefore has to undo the right one. Reopening a queue
 * answer must move no balance; reopening a declared one must move both back,
 * or the source stays down, the destination stays up, and the link that
 * explained them is gone.
 *
 * ## Why the source alone is not the test
 *
 * The obvious discriminator — *both legs are `user-balance-edit`* — is wrong,
 * and wrong in the direction that moves money nobody asked to move. A person
 * can raise one holding's balance by hand on Monday, lower another's on
 * Tuesday, and the queue can then legitimately pair those two rows: both legs
 * read `user-balance-edit`, no declaration ever happened, and undoing them
 * would silently restate two figures the owner set themselves.
 *
 * What a declaration actually is, is ONE act: `ManualBalanceEditService` keys
 * its dedup id on the edit instant (`manual-edit:<editedAt ISO>`), and a
 * declared transfer passes one `editedAt` to both legs precisely so a retried
 * submission collapses onto the two rows it already wrote. So the two legs of
 * a declaration share an `external_id` **by construction**, and two
 * independent edits cannot: they are different instants.
 *
 * That is the test. It is a fact about how the rows were WRITTEN rather than a
 * guess about what they mean, which is why it is here as one predicate instead
 * of an `if` at each call site.
 */

import { MANUAL_EDIT_FLOW_SOURCE } from '../services/holdings/ManualBalanceEditService';

/** The only leg facts the test below reads. */
export interface DeclaredPairLegFacts {
  readonly id: string;
  readonly holdingId: string;
  /** Signed: negative on the withdrawal, positive on the arrival. */
  readonly quantity: string;
  readonly source: string | null;
  readonly externalId: string | null;
}

/**
 * The two legs of a declared transfer, or `null` when this group is not one.
 *
 * Every clause refuses a real shape rather than guarding a hypothetical:
 *
 * - **exactly two legs** — a split answer writes more, and a group of one is a
 *   half-made pairing `linkDeclaredPair` already refuses to create.
 * - **both `user-balance-edit`** — an imported leg was observed by its
 *   importer, and its balance is not this answer's to restate.
 * - **the same non-null `external_id`** — one edit instant, so one declaration.
 *   See the module docblock: this is the clause that does the work.
 * - **two different holdings** — a transfer that arrives where it left moves
 *   nothing, and undoing it by subtracting both legs from one anchor would
 *   move that anchor by the difference rather than by nothing.
 */
export function declaredPairLegs<T extends DeclaredPairLegFacts>(
  legs: readonly T[]
): [T, T] | null {
  if (legs.length !== 2) return null;
  const [first, second] = legs as readonly [T, T];
  if (first.source !== MANUAL_EDIT_FLOW_SOURCE || second.source !== MANUAL_EDIT_FLOW_SOURCE) {
    return null;
  }
  if (!first.externalId || first.externalId !== second.externalId) return null;
  if (first.holdingId === second.holdingId) return null;
  return [first, second];
}
