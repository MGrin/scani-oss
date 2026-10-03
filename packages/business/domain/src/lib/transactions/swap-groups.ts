import type { NewHoldingTransaction } from '@scani/db/schema';

/** What settling a swap group reads and writes on a leg. */
export type SwapLeg = Pick<
  NewHoldingTransaction,
  | 'kind'
  | 'quantity'
  | 'swapGroupId'
  | 'counterTokenId'
  | 'counterQuantity'
  | 'priceNative'
  | 'priceNativeTokenId'
>;

/**
 * Turn each provider swap-group key into one `swap_group_id`, or undo the
 * swap where the group did not survive (SC-332). Returns the legs it undid.
 *
 * A provider knows two legs are one swap. It cannot know whether both
 * reach the ledger: wallet-derived sources resolve holdings FIND-ONLY, so
 * a leg whose token has no holding on the account is dropped, and
 * that is common — a token swapped into and later out of again leaves no
 * holding behind for its own history to land on.
 *
 * A leg left alone must not stay a swap, and the reason is that a lone
 * swap leg is worse than the plain transfer it replaced, twice over:
 *
 *  - it leaves the transfer-review queue, whose pending predicate is
 *    `kind IN ('withdraw','transfer_out')`, so the one question a human
 *    could still answer about it stops being asked; and
 *  - it asserts a trade whose other side is not in the ledger, so nothing
 *    can ever say what was received for it.
 *
 * The second reason USED to be that `CostBasisService.txValueInBase`
 * refused the held-token fallback for swap kinds, popping a partnerless
 * outflow's lots at ZERO realized. SC-397 removed that refusal — a leg
 * whose counter cannot be valued is now valued from the token that left —
 * so the revert is no longer what stands between a lone leg and a zero.
 * **It is still right**, and for the reason above rather than that one: a
 * lone leg is not a swap, and calling it one loses the only question a
 * person could still answer about it.
 *
 * Both remaining reasons are this repo's documented failure shape — a value
 * that reads as an answer nobody gave. So the leg goes back to being exactly
 * the transfer it was, and the caller says out loud that it did
 * (`orphanedSwapLegsNotice`).
 *
 * `groupIdOf` mints the id of a group that survived: the transaction router a
 * random one per run, feed ingest one derived from its input and the key, so
 * a re-import keeps it (A2 D-7).
 */
export function settleSwapGroups<T extends SwapLeg>(
  groups: ReadonlyMap<string, T[]>,
  groupIdOf: (key: string) => string
): T[] {
  const orphans: T[] = [];
  for (const [key, legs] of groups) {
    if (legs.length > 1) {
      const swapGroupId = groupIdOf(key);
      for (const leg of legs) leg.swapGroupId = swapGroupId;
      continue;
    }
    const orphan = legs[0];
    if (!orphan) continue;
    orphans.push(orphan);
    orphan.kind = orphan.quantity.trimStart().startsWith('-') ? 'transfer_out' : 'transfer_in';
    orphan.swapGroupId = null;
    orphan.counterTokenId = null;
    orphan.counterQuantity = null;
    orphan.priceNative = null;
    orphan.priceNativeTokenId = null;
  }
  return orphans;
}

export function orphanedSwapLegsNotice(orphaned: number): string {
  return `Recorded ${orphaned} swap leg(s) as plain transfers: the other side of the swap has no holding on this account, so nothing could be linked or priced.`;
}
