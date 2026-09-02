// Which tokens a wallet has TRADED, as opposed to which it merely received.
//
// Pure: no explorer, no database, no chain config. `BaseEvmProvider` supplies
// the movements from `txlist` + `tokentx` and this decides what they mean, so
// the rule can be tested without a network.
//
// WHY THE SIGNATURE IS THE DISCRIMINATOR AND THE BALANCE IS NOT (SC-398). The
// wallet review pre-creates holdings only for tokens with a CURRENT balance, so
// a token bought and fully exited before the first import never gets one — and
// `TransactionRouter` resolves wallet-derived sources FIND-ONLY, so the buy leg
// AND the sell leg are both dropped. The whole life of the position is
// invisible, with no row anywhere to notice.
//
// Relaxing that on balance alone re-admits every token that merely ARRIVED:
// airdrop spam, and worse, the address-poisoning contracts that emit a
// `Transfer` OUT of the victim's own address on a contract named `Tether USD`
// that is not Tether. `spam-filter.ts` matches token name and symbol and can
// never see those — the name is genuinely USDT's on a contract that is not.
// SC-348 made the same point about zero-value legs.
//
// The signature separates them structurally: those legs sit in transactions the
// wallet never signed, and the attacker cannot forge that. Measured on
// production 2026-08-18 across every EVM wallet account on four chains: over
// half the non-zero ERC-20 legs were dropped. The great majority of those are
// unsigned arrivals, but a minority are real positions carrying real realized
// PnL. `docs/technical/2026-08-18_sc398-findonly-drops.md`.

/** One token's movements through one wallet, reduced to what the verdict needs. */
export interface TokenMovements {
  /** Hashes of transactions in which the token arrived at the wallet. */
  readonly inflowHashes: readonly string[];
  /** Hashes of transactions in which the token left the wallet. */
  readonly outflowHashes: readonly string[];
  /** Every hash whose `txlist` row has `from` = the wallet — i.e. it signed. */
  readonly signedHashes: ReadonlySet<string>;
  /** Every hash in which the wallet sent non-zero value of ANY asset. */
  readonly paidHashes: ReadonlySet<string>;
}

export type DropClass =
  /** The wallet gave up value in the transaction that acquired it: a purchase. */
  | 'paid-for'
  /** Acquired free in a transaction the wallet signed, then sent on: an airdrop it claimed and disposed of. */
  | 'claimed-then-sent'
  /** Arrived unbidden, then sent on in a signed transaction: still a disposal. */
  | 'received-free-then-sent'
  /** Claimed free and never moved: an airdrop still sitting there. */
  | 'claimed-free'
  /** Never touched by a transaction the wallet signed. Spam, or poisoning. */
  | 'unsolicited-arrival';

export function classifyDrop(m: TokenMovements): DropClass {
  // A TOKEN CANNOT BE ITS OWN PAYMENT (SC-764). `paidHashes` records that the
  // wallet gave up value somewhere in a transaction, not WHICH asset, and this
  // token's own outflow is one of the things that puts a hash in there. So an
  // inflow whose only evidence of payment is the same token leaving in the
  // same transaction is not a purchase: "paid X to acquire X" describes a
  // round trip whoever emitted it. Unsigned, it is the poisoning shape with
  // both legs spoofed on one contract, and it was admitted as `paid-for`.
  const alsoLeftInTheSameTx = new Set(m.outflowHashes);
  const acquiredByPayment = m.inflowHashes.some(
    (h) => m.paidHashes.has(h) && !alsoLeftInTheSameTx.has(h)
  );
  if (acquiredByPayment) return 'paid-for';
  const acquiredInSignedTx = m.inflowHashes.some((h) => m.signedHashes.has(h));
  const disposedBySelf = m.outflowHashes.some((h) => m.signedHashes.has(h));
  if (disposedBySelf) return acquiredInSignedTx ? 'claimed-then-sent' : 'received-free-then-sent';
  if (acquiredInSignedTx) return 'claimed-free';
  return 'unsolicited-arrival';
}

/**
 * Whether a token's movements describe a position the wallet held, as opposed
 * to something that was sent to it.
 *
 * This is `classifyDrop` read for the one decision the import path makes.
 *
 * `paid-for` IS STILL REACHABLE WITHOUT A SIGNATURE, AND THAT IS DELIBERATE
 * (SC-764). Requiring one closes the poisoning shape in a line and takes real
 * purchases with it, because `signedHashes` is `txlist.from` = the wallet and
 * a purchase can be perfectly genuine without the wallet being that `from`:
 *
 *  - **An ordinary EOA on an intent protocol.** The owner signs an order
 *    off-chain and a solver submits the settlement, so the wallet is neither
 *    `from` nor `to` of that transaction and it is absent from `txlist`
 *    entirely. Both legs are in `tokentx` and nothing else records the trade.
 *  - **Any wallet that is not an EOA.** Only an externally-owned account can
 *    be a transaction's `from`, so a Safe or an ERC-4337 account has
 *    `signedHashes` empty for its WHOLE history, by protocol construction
 *    rather than by accident. `paid-for` is then the only class it can ever
 *    reach. `isEvmAddress` is a regex, so such an address imports exactly like
 *    an EOA and nothing upstream of here tells them apart.
 *
 * In both, a signature requirement answers `unsolicited-arrival` for a
 * position the wallet bought and sold — missing, with no row anywhere to
 * notice, which is the defect SC-398 exists to fix rather than a defence
 * against it.
 *
 * What SC-764 closed instead is the incoherent half: an inflow whose only
 * evidence of payment is that same token leaving in the same transaction. See
 * `classifyDrop`.
 *
 * THE RESIDUAL, named rather than implied away: an attacker emitting TWO fake
 * contracts in one unsigned transaction — a leg out of the victim on contract
 * A, a leg in on contract B — still reads as B bought with A. No rule over
 * this data refuses that without the signature, and the signature is what a
 * contract wallet does not have. The cost is unchanged and is what makes the
 * trade the right way round: one extra row offered at wallet review, unticked,
 * with the frontend `spamSignal` heuristic still on it — not a holding created
 * behind anybody's back.
 */
export function isTradedPosition(m: TokenMovements): boolean {
  return classifyDrop(m) !== 'unsolicited-arrival';
}
