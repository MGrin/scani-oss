import {
  ANSWERABLE_OUTFLOW_KINDS,
  TRANSFER_MATCH_WINDOW_MS,
  TRANSFER_MAX_COMBINED_ARRIVALS,
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

/**
 * The most deposits one withdrawal may be paired with (SC-1365). Money that
 * lands in parts lands in two or three; a combination search past that is a
 * search for a coincidence, and it grows with the number of subsets.
 */
export const MAX_COMBINED_ARRIVALS = TRANSFER_MAX_COMBINED_ARRIVALS;

/** Most plausible pairs first; `both_outside` is on the list only because
 *  nothing better is. Mirrors TRANSFER_CANDIDATE_REASONS in @scani/shared. */
export const CANDIDATE_REASON_RANK: Record<string, number> = {
  matches: 0,
  ambiguous: 1,
  quantity_outside_tolerance: 2,
  time_outside_window: 3,
  both_outside: 4,
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

export type CandidatePairClass = 'same_token' | 'bridged_asset';

export function crossesEntityBoundary(a: string | null, b: string | null): boolean {
  return a !== b;
}

/**
 * The UNATTENDED predicate: `reviewPairClass` plus the entity boundary.
 *
 * The strict one keeps the short name on purpose, so a caller that does not
 * choose gets the safe answer. Every job that links without anybody answering
 * — the nightly matcher and both repair passes — reads this one.
 */
export function candidatePairClass(
  out: TransferLeg,
  inflow: TransferLeg
): CandidatePairClass | null {
  if (crossesEntityBoundary(out.entityId, inflow.entityId)) return null;
  return reviewPairClass(out, inflow);
}

/**
 * Could these two rows be the same money, for a pair a PERSON is choosing
 * (SC-1364)? The review queue's candidate list and its `paired` write.
 *
 * No entity boundary, for the reason `crossesEntityBoundary` gives: it is a
 * question about who decides, and here somebody does. Leaving it in made the
 * queue refuse to link a company-to-personal transfer to the arrival its owner
 * had already recorded, while `internal` — which writes a SECOND arrival — was
 * allowed across the same boundary. The one answer on offer invented money.
 */
export function reviewPairClass(out: TransferLeg, inflow: TransferLeg): CandidatePairClass | null {
  if (out.transactionId === inflow.transactionId) return null;
  if (out.holdingId === inflow.holdingId) return null;
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

export interface ArrivalPart {
  readonly transactionId: string;
  readonly holdingId: string;
  readonly quantityAbs: Decimal;
  readonly occurredAt: Date;
}

/** How many of a holding's arrivals the search looks at, earliest first. */
const COMBINATION_PARTS_PER_HOLDING = 12;

/**
 * Sets of arrivals on ONE holding whose total is the withdrawal, within the
 * candidate net (SC-1365). 2 to `MAX_COMBINED_ARRIVALS` parts each, best total
 * first, at most `limit` of them.
 *
 * One holding, because this is money that landed in parts in one place — a
 * transfer recorded as it arrived. Parts spread over several accounts are a
 * different story, and the search would be finding coincidences.
 *
 * Only arrivals at or after the withdrawal, and each smaller than it: a part
 * that is the whole amount on its own is a single candidate, not a piece.
 */
export function arrivalCombinations(
  outflow: { quantityAbs: Decimal; occurredAt: Date },
  arrivals: ReadonlyArray<ArrivalPart>,
  limit = 3
): ArrivalPart[][] {
  const byHolding = new Map<string, ArrivalPart[]>();
  for (const part of arrivals) {
    if (part.occurredAt.getTime() < outflow.occurredAt.getTime()) continue;
    if (part.quantityAbs.lte(0) || part.quantityAbs.gte(outflow.quantityAbs)) continue;
    const list = byHolding.get(part.holdingId);
    if (list) list.push(part);
    else byHolding.set(part.holdingId, [part]);
  }

  const tolerance = outflow.quantityAbs.mul(CANDIDATE_QTY_EPSILON);
  const found: Array<{ parts: ArrivalPart[]; miss: Decimal }> = [];
  for (const list of byHolding.values()) {
    const pool = list
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .slice(0, COMBINATION_PARTS_PER_HOLDING);
    const walk = (start: number, chosen: ArrivalPart[], total: Decimal): void => {
      if (chosen.length >= 2) {
        const miss = total.minus(outflow.quantityAbs).abs();
        if (miss.lte(tolerance)) found.push({ parts: [...chosen], miss });
      }
      if (chosen.length === MAX_COMBINED_ARRIVALS) return;
      for (let i = start; i < pool.length; i++) {
        const part = pool[i] as ArrivalPart;
        const next = total.add(part.quantityAbs);
        if (next.gt(outflow.quantityAbs.add(tolerance))) continue;
        walk(i + 1, [...chosen, part], next);
      }
    };
    walk(0, [], new Decimal(0));
  }

  return found
    .sort((a, b) => a.miss.comparedTo(b.miss) || a.parts.length - b.parts.length)
    .slice(0, limit)
    .map((f) => f.parts);
}
