import type { ExitedPosition, HoldingSnapshot } from '@scani/providers/core/types';

/**
 * The extra rows a wallet review offers for positions the wallet TRADED and no
 * longer holds (SC-398).
 *
 * `fetchBalances` answers *what is here now*, and until this existed that was
 * the whole offer list — so a token bought and fully exited before the first
 * import was offered to nobody, got no holding, and then had BOTH its legs
 * dropped by `TransactionRouter`'s find-only resolution. PUNKS, GALA,
 * ETHBTCTrend and cbETH have zero rows anywhere in the production ledger and
 * every one of them was bought with the owner's own ETH.
 *
 * Two subtractions, and they are refusals for different reasons:
 *
 *  - **already in the balances.** The provider measured each of these at zero
 *    before returning it, so this should never fire — but the two balance
 *    reads happen at different moments, and an asset that arrived between them
 *    would otherwise produce two rows with one `externalId`, which is a
 *    duplicate holding rather than a cosmetic one.
 *  - **already excluded.** A token the review OFFERED and the user did not
 *    keep is an ANSWER, not an omission. Measured on production 2026-08-18:
 *    PUNKS is paid for, 107.59 of it is still in the wallet, it was shown at
 *    review and declined. Re-offering it PRE-TICKED — which is what
 *    `initialWalletSelection` does with any row the spam heuristic does not
 *    flag — would let a click-through import something the person had already
 *    said no to. Respecting it costs 162.99 of realized gain, measured by
 *    running the SC-398 dry run with the gate removed.
 *
 * NOTE WHICH ROWS THE SECOND GATE COVERS: only these. A held token the user
 * declined is still re-offered on a re-import, exactly as it is today — that
 * is their way back to a decision they want to change, and taking it away is
 * not this ticket's to do.
 *
 * Every row comes back at balance `'0'`, which is a MEASURED figure rather
 * than an inference from absence: `ExitedPosition` is only produced for an
 * asset whose current balance was read and found zero. It matters because
 * `holdings.balance` is an anchor rather than a sum, so the zero is what the
 * reconstructed history is built backwards from.
 */
export function exitedPositionSnapshots(args: {
  balances: readonly HoldingSnapshot[];
  exited: readonly ExitedPosition[];
  /** `institutionId:externalId` keys, as `HoldingExclusionRepository` emits them. */
  excludedKeys: ReadonlySet<string>;
  institutionId: string;
  capturedAt: Date;
}): HoldingSnapshot[] {
  const held = new Set(args.balances.map((s) => s.externalId.toLowerCase()));
  const out: HoldingSnapshot[] = [];
  const seen = new Set<string>();
  for (const position of args.exited) {
    const key = position.externalId.toLowerCase();
    if (held.has(key) || seen.has(key)) continue;
    if (args.excludedKeys.has(`${args.institutionId}:${position.externalId}`)) continue;
    seen.add(key);
    out.push({
      externalId: position.externalId,
      tokenIdentity: position.tokenIdentity,
      balance: '0',
      capturedAt: args.capturedAt,
      tokenType: position.tokenType,
    });
  }
  return out;
}
