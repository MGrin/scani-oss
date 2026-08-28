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
// production 2026-08-18 across nine EVM wallet accounts on four chains — 914
// non-zero ERC-20 legs, 484 dropped across 348 tokens, of which 330 tokens /
// 419 legs are unsigned arrivals and 14 tokens / 58 legs are real positions
// worth +17,444.88 of realized PnL. `docs/technical/2026-08-18_sc398-findonly-drops.md`.

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
  const acquiredByPayment = m.inflowHashes.some((h) => m.paidHashes.has(h));
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
 * This is `classifyDrop` read for the one decision the import path makes, and
 * it is deliberately the measured rule rather than a tighter one. `paid-for` is
 * reachable WITHOUT a signature — an inflow whose hash carries any outbound leg
 * of the wallet's, signed or not — and a spoofed `Transfer` out of the victim's
 * own address is exactly such a leg. A poisoning contract that emitted BOTH an
 * in and an out leg in one unsigned transaction would therefore pass here.
 * Production carries no such shape today (every poisoning contract measured
 * emits the outflow alone, which classifies `unsolicited-arrival`), and the
 * cost if one appeared is one extra unticked row on a review card rather than a
 * holding created behind anybody's back. Narrowing the rule is SC-764, filed
 * separately so the shipped predicate stays the one the numbers were measured
 * against.
 */
export function isTradedPosition(m: TokenMovements): boolean {
  return classifyDrop(m) !== 'unsolicited-arrival';
}
