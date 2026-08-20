/**
 * What a repair would DO to a same-holding transfer group, asked before the
 * write instead of discovered during it (SC-376, SC-378).
 *
 * WHY THIS IS A MODULE AND NOT TWO `if`s.
 *
 * `unpick-same-holding-transfer-groups.ts` decided what to unlink from
 * `sameHoldingGroupVerdict` alone and then handed each survivor to
 * `unlinkPair`, which applies a SECOND gate the projection never modelled: a
 * group any leg of which carries an answer comes back `reviewed` and is left
 * alone. On 2026-08-18 that printed `7 would be unlinked / 0 REFUSED` against
 * production and then refused all seven, having also projected cost-basis and
 * realized-PnL deltas across seven rows that were never going to move.
 *
 * It failed safe — nothing was written — and that is the only reason it was
 * cheap. A preview exists so a person can authorise a production write by
 * READING it, so a preview that describes a write the write path will refuse
 * is the same defect as one that under-reports a refusal in a script that does
 * write. The repair is not a better guess in the script: it is that both paths
 * ask ONE function, so "would be unlinked" cannot drift from what happens.
 *
 * The projection cannot MEMORISE the answer either, and the incident says why.
 * The script's header recorded, correctly when written, that production held
 * exactly one answered group (`b6b6506e`, 2026-08-17 08:31). By the time the
 * unpick ran, six more had been answered at 15:08-15:09 the same day. A gate
 * read from a comment is a gate read at the wrong time.
 *
 * SINCE SC-378 THERE ARE TWO WRITES, AND THEY ARE DISJOINT BY CONSTRUCTION.
 *
 * `unlinkPair` breaks an UNANSWERED artifact. `withdrawSameHoldingPairing`
 * breaks an ANSWERED one, clearing the answer as a `repair`. Each refuses
 * exactly where the other applies — `unlinkPairRefusal` refuses on an answer,
 * `withdrawPairingRefusal` refuses on the absence of one — so there is no
 * group both accept and none that neither reaches. `sameHoldingRepairPlan`
 * asks both, in that order, and returns the ONE action a caller should take.
 */

import type { SameHoldingGroupVerdict } from './upstream-event';
import { type GroupLegFacts, sameHoldingGroupVerdict } from './upstream-event';

/** The only leg fact `unlinkPair`'s refusal depends on. */
export interface UnlinkLegReviewFacts {
  readonly transferReview: string | null;
}

/** Everything either write path's gate reads, plus the id it reports back. */
export interface RepairLegFacts extends GroupLegFacts, UnlinkLegReviewFacts {
  readonly id: string;
}

/**
 * Why a write refused, in a shape both the write and its projection return.
 *
 * The reason is a type parameter rather than one union across both writes so
 * each path's result stays exact: `unlinkPair` can only ever say `reviewed`,
 * and a caller switching on its result should not have to handle two reasons
 * it will never be given.
 */
export interface RepairRefusal<R extends string> {
  readonly reason: R;
  /** Operator-readable, naming what causes it. */
  readonly detail: string;
}

/** `unlinkPair` refuses on one thing: some leg carries an answer. */
export type UnlinkRefusalReason = 'reviewed';
export type UnlinkRefusal = RepairRefusal<UnlinkRefusalReason>;

/**
 * `withdrawSameHoldingPairing` refuses on the two ways a group is not its
 * business: it is not a provable artifact, or nobody answered it.
 */
export type WithdrawRefusalReason = 'not_artifact' | 'no_answer';
export type WithdrawRefusal = RepairRefusal<WithdrawRefusalReason>;

/**
 * Why `unlinkPair` would refuse this group, or null if it would proceed.
 *
 * Called by `unlinkPair` itself, so a caller that asks first gets the write
 * path's own answer rather than a second opinion about it. It is deliberately
 * a pure function of the legs: `gone` — the row vanished or lost its group id
 * between the read and the write — is NOT expressible here and must not be
 * faked, because a projection that claims to have ruled out a race has told a
 * second lie in place of the first.
 */
export function unlinkPairRefusal(legs: ReadonlyArray<UnlinkLegReviewFacts>): UnlinkRefusal | null {
  const answers = legs.flatMap((leg) => (leg.transferReview === null ? [] : [leg.transferReview]));
  if (answers.length === 0) return null;
  return {
    reason: 'reviewed',
    detail:
      `${answers.length} of ${legs.length} leg(s) answered ` +
      `(${[...new Set(answers)].sort().join(', ')}) — reopen them first`,
  };
}

/**
 * Why `withdrawSameHoldingPairing` would refuse this group, or null if it
 * would proceed — AND THE WHOLE OF HOW THAT OPERATION IS SCOPED (SC-378).
 *
 * Withdrawing clears an answer somebody gave, which every other rule in this
 * codebase forbids. It is permitted here on one specific ground and the ground
 * has to be provable, not asserted by the caller: `sameHoldingGroupVerdict`
 * must return `unlink`, meaning both legs sit on ONE holding and carry two
 * DIFFERENT upstream event ids. A group like that is not a movement — nothing
 * went anywhere — so the `paired` on it refers to a transfer that did not
 * happen, given on the strength of a queue that offered the row as a candidate
 * before SC-347's matcher guard stopped it being one.
 *
 * **The scope is this function, not the caller's care.** There is no flag, no
 * id list and no `force` that reaches past it; the service calls it on legs it
 * read inside its own transaction, so a group that spans two holdings, mixes
 * two sources, or shares one event id is refused however it was named. That is
 * the difference between "a repair may correct a provably false pairing" and
 * "a repair may overwrite an answer", and only the first one is true.
 *
 * The `no_answer` refusal is the other half of the disjointness: an artifact
 * nobody answered is `unlinkPair`'s, and routing it here instead would mean the
 * ordinary unlink path runs through a method that can clear answers.
 */
export function withdrawPairingRefusal(
  legs: ReadonlyArray<RepairLegFacts>
): WithdrawRefusal | null {
  const verdict = sameHoldingGroupVerdict(legs);
  if (!verdict.unlink) return { reason: 'not_artifact', detail: verdict.reason };
  if (legs.every((leg) => leg.transferReview === null)) {
    return {
      reason: 'no_answer',
      detail: 'no leg carries an answer — unlinkPair is the operation for this group',
    };
  }
  return null;
}

/** The one write a caller should make for this group. */
export type SameHoldingRepairAction = 'unlink' | 'withdraw' | 'keep';

export interface SameHoldingRepairPlan {
  /**
   * `unlink` → `unlinkPair`; `withdraw` → `withdrawSameHoldingPairing`;
   * `keep` → nothing, and `refusal` says why when there was a reason to look.
   */
  readonly action: SameHoldingRepairAction;
  /** Whether the group is a matcher artifact at all. */
  readonly verdict: SameHoldingGroupVerdict;
  /** Set only when the verdict says artifact and BOTH writes would refuse. */
  readonly refusal: WithdrawRefusal | null;
  /** The legs whose answer `withdraw` clears. Empty for every other action. */
  readonly clears: ReadonlyArray<RepairLegFacts>;
}

/**
 * The whole dry-run decision for one same-holding group, in the order a caller
 * must apply it: is this an artifact, and which write would go through.
 *
 * A group the verdict already keeps is not asked anything further — its legs
 * are never handed to either write, so a refusal there would be a reason the
 * reader is not owed.
 *
 * Both branches read the write paths' OWN predicates rather than restating
 * them, which is the entire point of the module: "would be unlinked" and
 * "would be withdrawn" cannot mean something the writes refuse.
 */
export function sameHoldingRepairPlan(legs: ReadonlyArray<RepairLegFacts>): SameHoldingRepairPlan {
  const verdict = sameHoldingGroupVerdict(legs);
  if (!verdict.unlink) return { action: 'keep', verdict, refusal: null, clears: [] };

  if (unlinkPairRefusal(legs) === null) {
    return { action: 'unlink', verdict, refusal: null, clears: [] };
  }
  const withdrawRefusal = withdrawPairingRefusal(legs);
  if (withdrawRefusal === null) {
    return {
      action: 'withdraw',
      verdict,
      refusal: null,
      clears: legs.filter((leg) => leg.transferReview !== null),
    };
  }
  return { action: 'keep', verdict, refusal: withdrawRefusal, clears: [] };
}
