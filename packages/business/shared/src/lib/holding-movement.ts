import { TRANSFER_REVIEW_DECISIONS } from '../dtos/transfer-review';

/**
 * What the owner DID, said in their own terms (SC-607).
 *
 * ## The gap this closes
 *
 * A manual holding has one verb: set the amount to a new number. Every other
 * fact about it is inferred backwards from the delta — which is why SC-501 and
 * SC-510 both exist, and why one edit can raise three questions.
 *
 * But the owner knows the MOVEMENT, not the resulting balance. *"I withdrew
 * 2000"* is the fact; *"the balance is now 2000"* is a consequence they had to
 * compute. Asking for the consequence and then interrogating them to recover
 * the fact is the whole defect.
 *
 * ## Why this adds no vocabulary to the ledger
 *
 * Nothing here is a new kind of ledger row. A movement is expressed entirely
 * in terms that already exist: `ManualEditCause.flow` for every leg, and
 * `TRANSFER_REVIEW_DECISIONS` for what an outflow meant. What is new is only
 * that the owner states the amount that MOVED and the server computes the
 * balance, rather than the reverse.
 *
 * A `transfer` is two flows plus a `transfer_group_id`, which is what a
 * transfer has always been here. It is written as one act because a declared
 * pair is not a discovery: `LinkTransferPairsUseCase` exists to guess at pairs
 * nobody stated, and running its ±1% / ±30-minute heuristic over two rows we
 * just wrote ourselves would be inventing uncertainty we do not have.
 */

/** The three things an owner can say happened to a manual holding. */
export const HOLDING_MOVEMENT_DIRECTIONS = ['inflow', 'outflow', 'transfer'] as const;

export type HoldingMovementDirection = (typeof HOLDING_MOVEMENT_DIRECTIONS)[number];

export function isHoldingMovementDirection(value: unknown): value is HoldingMovementDirection {
  return (
    typeof value === 'string' && (HOLDING_MOVEMENT_DIRECTIONS as readonly string[]).includes(value)
  );
}

/**
 * Where an outflow went — asked IN the form, for every holding, with no
 * default (mgrin, 2026-08-25).
 *
 * ## Why there is no default, on any token type
 *
 * A bare outflow still has to say what it was, or the row sits unanswered in
 * the transfer-review queue and this feature has moved a prompt rather than
 * removed one. Only two `TRANSFER_REVIEW_DECISIONS` members can apply, and
 * choosing between them is a tax-realizing decision:
 *
 * - `left_control` — it left the portfolio. `CostBasisService` realizes it at
 *   market. Guess this on crypto moved to a cold wallet and a taxable
 *   disposal is booked that never happened.
 * - `untracked` — still the owner's money somewhere Scani cannot see. Nothing
 *   is realized. Guess this on a genuine sale and a real gain silently
 *   disappears.
 *
 * Neither error announces itself; both render as a plausible figure, and
 * neither would fail a test. So neither is safe to infer, and the question is
 * asked of everyone.
 *
 * **Asking here is not the prompt this ticket removes.** The defect was being
 * interrogated AFTERWARDS to recover a fact the owner already held. This is
 * the same fact, stated once, in the form that records it — one submit, no
 * follow-up. The review-prompt count stays zero.
 *
 * A per-token-type exemption for fiat was considered and rejected: it is true
 * that cash realizes nothing either way, which makes the choice free on
 * exactly the holding this was reported from — and that is precisely why it
 * would have looked cosmetic while being load-bearing on the crypto and stock
 * holdings that are most of this product.
 */
export const OUTFLOW_DESTINATIONS = ['left_control', 'untracked'] as const;

export type OutflowDestination = (typeof OUTFLOW_DESTINATIONS)[number];

export function isOutflowDestination(value: unknown): value is OutflowDestination {
  return typeof value === 'string' && (OUTFLOW_DESTINATIONS as readonly string[]).includes(value);
}

/**
 * Both members are `TRANSFER_REVIEW_DECISIONS`, verbatim rather than a
 * parallel vocabulary that happens to agree today.
 *
 * The value written here IS the queue's answer — it is what makes the row
 * answered rather than pending — so a second spelling of `left_control` would
 * be a row that reads as answered to this feature and as unanswered to the
 * queue. Asserted rather than commented because the two lists are edited by
 * different tickets.
 */
export function outflowDestinationIsReviewDecision(value: OutflowDestination): boolean {
  return (TRANSFER_REVIEW_DECISIONS as readonly string[]).includes(value);
}
