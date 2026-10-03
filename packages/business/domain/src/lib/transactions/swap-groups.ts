import type { NewHoldingTransaction } from '@scani/db/schema';

/** What undoing a swap reads and writes on a leg. */
type SwapLeg = Pick<
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
 * The legs that are alone under their provider swap-group key: the swaps that
 * did not survive (SC-332). A leg with no key is not a swap leg and is not one
 * of them; the legs of a group that did survive share one `swap_group_id`,
 * which feed ingest derives from its input and the key, so a re-import keeps
 * it (A2 D-7).
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
 * the transfer it was (`demoteSwapLeg`), and the caller says out loud that it
 * did (`orphanedSwapLegsNotice`).
 */
export function loneSwapLegs<T>(
  legs: readonly T[],
  groupKeyOf: (leg: T) => string | undefined
): Set<T> {
  const groups = new Map<string, T[]>();
  for (const leg of legs) {
    const key = groupKeyOf(leg);
    if (!key) continue;
    const siblings = groups.get(key);
    if (siblings) siblings.push(leg);
    else groups.set(key, [leg]);
  }
  return new Set([...groups.values()].flatMap((group) => (group.length === 1 ? group : [])));
}

/** Turns a lone swap leg back into the transfer it was. */
export function demoteSwapLeg(leg: SwapLeg): void {
  leg.kind = leg.quantity.trimStart().startsWith('-') ? 'transfer_out' : 'transfer_in';
  leg.swapGroupId = null;
  leg.counterTokenId = null;
  leg.counterQuantity = null;
  leg.priceNative = null;
  leg.priceNativeTokenId = null;
}

export function orphanedSwapLegsNotice(orphaned: number): string {
  return `Recorded ${orphaned} swap leg(s) as plain transfers: the other side of the swap has no holding on this account, so nothing could be linked or priced.`;
}
