import { TRANSFER_MATCH_WINDOW_MS, TRANSFER_QTY_EPSILON } from '@scani/shared';
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

export const OUTFLOW_KINDS = ['withdraw', 'transfer_out'] as const;
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
