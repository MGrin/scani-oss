import type { ManualOutflowDestination } from '../dtos/transfer-review';

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
 * ## There is no vocabulary here on purpose
 *
 * The answers are `MANUAL_OUTFLOW_DESTINATIONS` (SC-606), used verbatim. A
 * second list that happened to agree today would be free to disagree
 * tomorrow, and the disagreement would render as a queue asking about a row
 * this feature had already settled — which is that list's own stated reason
 * for existing beside `TRANSFER_REVIEW_DECISIONS` rather than apart from it.
 *
 * ## Why `internal` is refused HERE and nowhere else
 *
 * Because this direction cannot SAY it. `internal` means "it went to that
 * holding of mine", and the answer is only complete with a
 * `TransferDestinationRef` naming which — a field the `outflow` shape does not
 * carry and deliberately does not, since the `transfer` DIRECTION below is
 * where a destination account belongs. An `internal` accepted here would be an
 * answer with nowhere to point.
 *
 * So the third thing a person can say about an outflow — *it went to another
 * account I hold* — is the `transfer` direction, which writes both legs and
 * links them. Same answer, expressed where it can be true.
 *
 * **This used to be justified by `writeInflow` never moving an existing
 * destination's balance, and that reason is gone (SC-614).** The manual path
 * no longer routes an `internal` answer through `writeInflow` at all:
 * `UpdateHoldingUseCase.moveDeclaredTransfer` writes both legs and moves both
 * anchors, exactly as a `transfer` here does. The refusal survives its own
 * reason because the structural one above was always the stronger of the two.
 *
 * ## Why no default, on any token type
 *
 * Only `left_control` (realizes at market) and `untracked` (realizes nothing)
 * remain, and choosing between them is a tax-realizing decision. Guess
 * `left_control` on crypto moved to a cold wallet and a disposal is booked
 * that never happened; guess `untracked` on a genuine sale and a real gain
 * disappears. Neither error announces itself, both render as a plausible
 * figure, and neither would fail a test.
 *
 * **Asking here is not the prompt this ticket removes.** The defect was being
 * interrogated AFTERWARDS to recover a fact the owner already held. This is
 * the same fact, stated once, in the form that records it.
 *
 * A fiat exemption was considered and rejected: cash realizes nothing either
 * way, which makes the choice free on exactly the holding this was reported
 * from and load-bearing on the crypto and stock holdings that are most of
 * this product.
 */
export function movementOutflowRefusesInternal(decision: ManualOutflowDestination): boolean {
  return decision === 'internal';
}
