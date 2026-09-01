import {
  ANSWERABLE_OUTFLOW_KINDS,
  TRANSFER_MATCH_WINDOW_MS,
  TRANSFER_QTY_EPSILON,
} from '@scani/shared';
import Decimal from 'decimal.js';

/**
 * The transfer matcher's rules, in one place.
 *
 * These used to be private to `LinkTransferPairsUseCase`. They moved here
 * when the review surface arrived (SC-150), because that surface's whole job
 * is to explain *why the matcher refused a candidate* — "3.4% apart, outside
 * the ±1% we allow" — and an explanation computed from a second copy of the
 * tolerance is an explanation that goes quietly wrong the first time somebody
 * tunes one of them.
 */

/** The kinds the review queue can ask about. Re-exported from `@scani/shared`
 *  under the name eight call sites here already use, because the realized
 *  ledger needs the same set in the browser and a second copy of it is exactly
 *  how a row ended up on no queue and yet stamped "nobody answered" (SC-402). */
export const OUTFLOW_KINDS = ANSWERABLE_OUTFLOW_KINDS;
export const INFLOW_KINDS = ['deposit', 'transfer_in'] as const;

/** CEX queues delay; chain finality is minutes. Re-exported from
 *  `@scani/shared` so the review surface's explanation of the rule and the
 *  rule itself cannot drift apart. */
export const MATCH_WINDOW_MS = TRANSFER_MATCH_WINDOW_MS;

/** 1% drift absorbs typical network fees. */
export const QTY_MATCH_EPSILON = new Decimal(TRANSFER_QTY_EPSILON);

/**
 * How far the *review surface* looks, which is deliberately much further than
 * the matcher does.
 *
 * Widening what a human is shown is the opposite of widening what the machine
 * decides: the matcher stays at ±1% / ±30min precisely because auto-linking
 * the wrong leg corrupts cost basis worse than not linking at all, while a
 * reader who can see the 4-hour-late deposit of the same 0.5 ETH can settle it
 * in one tap. Nothing found in this wider net is ever linked automatically.
 *
 * ±10% covers a fixed-fee withdrawal on a small amount, where a percentage
 * tolerance is the wrong shape entirely. ±7 days covers a CEX withdrawal held
 * for manual review over a weekend, which is the longest real delay we have
 * seen.
 */
export const CANDIDATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CANDIDATE_QTY_EPSILON = new Decimal('0.10');

/** Most plausible pairs first; `both_outside` is on the list only because
 *  nothing better is. Mirrors TRANSFER_CANDIDATE_REASONS in @scani/shared. */
export const CANDIDATE_REASON_RANK: Record<string, number> = {
  ambiguous: 0,
  quantity_outside_tolerance: 1,
  time_outside_window: 2,
  both_outside: 3,
};

/**
 * One side of a possible pair, reduced to the facts that decide whether the
 * two sides can be the same money at all.
 *
 * Deliberately not a `HoldingTransaction`: the identity facts live on three
 * other tables (the token's canonical key, the account's wallet and chain),
 * and a predicate that took the row would have to reach for them itself. Both
 * callers already join those tables for their own reasons.
 */
export interface TransferLeg {
  readonly transactionId: string;
  readonly holdingId: string;
  readonly tokenId: string;
  /**
   * WHICH ASSET this is, according to something other than us:
   * `tokens.providerMetadata.coingecko.id`. Null when we hold no such id,
   * which is most memecoins and every private asset — and null never matches
   * null, so an asset we cannot name cannot be paired across chains.
   */
  readonly canonicalAssetKey: string | null;
  /** The wallet entity behind this leg's account. Null for exchange accounts. */
  readonly walletId: string | null;
  /** The chain that account lives on. Null for exchange accounts. */
  readonly chainKey: string | null;
  /**
   * The ownership boundary this leg's account sits in, or null for unassigned
   * (SC-463). Unlike `canonicalAssetKey`, null DOES match null here, and that
   * is deliberate: two unassigned accounts are on the same side of a boundary
   * nobody has drawn, so this condition is a no-op until somebody draws one.
   */
  readonly entityId: string | null;
  readonly occurredAt: Date;
  readonly quantityAbs: Decimal;
}

/**
 * Why two legs could be one movement.
 *
 * - `same_token` — one token row, two holdings. The original case: a CEX
 *   withdrawal and the wallet deposit it became. Native assets fall in here
 *   across chains too, because ETH on Base and ETH on mainnet are ONE token
 *   row (production, 2026-08-17), which is why two of the bridges in this
 *   ledger were already paired before SC-336 existed.
 * - `bridged_asset` — two token rows that are the same asset on two chains.
 */
export type CandidatePairClass = 'same_token' | 'bridged_asset';

/**
 * Whether an outflow and an inflow can be the same money, on identity and
 * direction alone (SC-336). Quantity and time are the CALLER's to apply —
 * the matcher and the review surface deliberately use different bounds for
 * those, and only for those.
 *
 * A bridge moves an asset to another chain; the value never leaves the
 * portfolio, so nothing is realized. Ingest cannot see it — the two legs are
 * in different runs on different chains — so this is the matcher's shape, and
 * the question it has to answer is "same asset, two chains?" without letting
 * anything counterfeit that shape. Six conditions, each closing one way to
 * counterfeit it — conditions 4 and 6 applying to every pair and the other
 * four to a bridge, which the three paragraphs after the list account for:
 *
 * 1. **The asset is named by an outside authority, never by its symbol.**
 *    `coingecko.id`, the same key `TokenRepository.findPricingSiblings` uses
 *    for the same reason (SC-198): production holds nine rows whose whole
 *    purpose is to carry a symbol matching a real token's, and two honest
 *    `TRUMP`s that are different coins. Symbol equality is how a memecoin
 *    named USDC gets paired with real USDC. It also keeps WETH out of ETH —
 *    `weth` and `ethereum` are different ids, and a wrapper is a different
 *    asset with a different basis.
 * 2. **The two rows are DIFFERENT token rows.** Same row is `same_token`,
 *    which needs none of this.
 * 3. **One wallet, two chains.** The wallet entity (`accounts.metadata
 *    .userWalletId`) rather than an address string, so it holds for any chain
 *    family; the chain from the same place. A default bridge sends to the
 *    sender's own address, and requiring that is what separates a bridge from
 *    a payment that happens to be followed by an unrelated arrival. A bridge
 *    to a DIFFERENT wallet the user owns is real and is deliberately not
 *    recognised here — it needs the destination address, which no column
 *    carries yet.
 * 4. **Two holdings.** A pair that resolves to one holding describes a move
 *    from a position to itself, which is not a thing that happens (SC-347).
 * 6. **Both legs are in the same set of books.** An entity is an ownership
 *    boundary over accounts — the owner's own money and their limited
 *    company's (SC-463) — and money crossing it is a real event on both sets
 *    of books: a director's loan, a dividend, a salary. Pairing carries the
 *    lot basis across intact and realizes nothing, which is the wrong answer
 *    on both sides at once. So a cross-entity movement is never a candidate,
 *    and the outflow stays unpaired and unanswered, which is precisely what
 *    puts it in the review queue (`pendingPredicate`) for its owner to
 *    classify.
 *
 *    **It is in this function rather than in the matcher because the matcher
 *    is not the only thing that pairs.** `TransferReviewService` judges
 *    candidates through here too — its `transferLegFacts` comment calls
 *    itself "a projection three queries here share" — so a guard in
 *    `LinkTransferPairsUseCase` alone would stop the automatic pairing and
 *    leave the queue RECOMMENDING the same one with an Accept button. The
 *    carry would happen anyway and arrive wearing a reader's provenance,
 *    which every downstream consumer trusts more than a machine match.
 *    `RepairBridgedOutflowsUseCase` is the third caller and is gated by the
 *    same predicate; there it degrades to that use case's own first-class
 *    `blocked` outcome, so a cross-entity bridge is reported as unrepairable
 *    rather than silently skipped.
 *
 *    Null matches null, so this changes nothing for a portfolio whose owner
 *    has drawn no boundary — which is every portfolio until they do.
 * 5. **The arrival does not precede the departure.** Physics, not tolerance,
 *    so it belongs here and not in a window. Measured on production: the
 *    ±30min window symmetric around the departure offers pairs whose arrival
 *    lands BEFORE the money left, and every one of them is false.
 *
 * **Condition 5 is deliberately NOT applied to `same_token`, and that is not
 * an oversight.** A `same_token` pair can be one movement reported by two
 * providers with two clocks: a substantial share of the genuine cross-holding
 * groups in production are a Kraken withdrawal to the owner's own wallet where
 * Kraken stamps its ledger entry 1-2 minutes AFTER the chain block, so the arrival
 * legitimately precedes the departure. Physics constrains the money, not two
 * vendors' timestamps; a bridge is held to the stricter rule because its two
 * legs come from the same kind of source and skew is not available as an
 * excuse.
 *
 * **Condition 4 IS applied to both, and used not to be.** `same_token`
 * returned before the holding was looked at, so the rule this docblock has
 * always claimed held for bridges alone — while every same-holding group ever
 * written to production is a `same_token` pair (43 of them, SC-347). The
 * matcher carried its own copy of the guard at the call site and was therefore
 * safe; `candidatesFor` and `claimInflow` had none, which is how a reader was
 * shown, and answered `paired` on, an arrival three days older than the
 * departure on the same holding.
 */
export function candidatePairClass(
  out: TransferLeg,
  inflow: TransferLeg
): CandidatePairClass | null {
  if (out.transactionId === inflow.transactionId) return null;
  if (out.holdingId === inflow.holdingId) return null;
  // Above the `same_token` return on purpose: that branch exits early, so a
  // boundary check below it would guard bridges only — and the common
  // cross-entity movement (moving cash from the company to yourself) is the
  // same token, not a bridge.
  if (out.entityId !== inflow.entityId) return null;
  if (out.tokenId === inflow.tokenId) return 'same_token';
  if (out.canonicalAssetKey === null || out.canonicalAssetKey !== inflow.canonicalAssetKey) {
    return null;
  }
  if (out.walletId === null || out.walletId !== inflow.walletId) return null;
  if (out.chainKey === null || inflow.chainKey === null || out.chainKey === inflow.chainKey) {
    return null;
  }
  if (inflow.occurredAt.getTime() < out.occurredAt.getTime()) return null;
  return 'bridged_asset';
}
