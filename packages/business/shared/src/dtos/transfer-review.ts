import { z } from 'zod';

/**
 * The transfer-review contract (SC-150).
 *
 * Background, because the shape only makes sense against it: an outflow that
 * `LinkTransferPairsUseCase` cannot pair to an inflow is treated by
 * `CostBasisService` as an exit from the portfolio and realized at market
 * value. That is a taxable event and a realized gain the user never made, and
 * the error only ever points one way — a missed pairing invents a gain, it can
 * never invent a loss. Whether moving your own coins from an exchange to your
 * own wallet counts as a sale therefore depends on whether a nightly job
 * matched two rows within ±1% and ±30 minutes.
 *
 * The fix is not a better heuristic. It is asking.
 */

/**
 * The matcher's own tolerances, in the one place both sides can read.
 *
 * They live here rather than in `@scani/domain` because the review surface's
 * job is to *explain* them — "outside the 30-minute window we match on" — and
 * an explanation with its own copy of the number goes quietly wrong the first
 * time somebody tunes one. `packages/business/domain/src/lib/transfer-matching.ts`
 * imports these; nothing redefines them.
 */
export const TRANSFER_MATCH_WINDOW_MS = 30 * 60 * 1000;
export const TRANSFER_MATCH_WINDOW_LABEL = '30-minute';
export const TRANSFER_QTY_EPSILON = 0.01;

/**
 * What a person can say about an unpaired outflow. Three answers, no snooze:
 * a queue that can be deferred is a queue that is never emptied, and the whole
 * value here is that the count reaching zero means something.
 *
 * - `paired` — "this is the same money as that inflow". Writes a shared
 *   `transfer_group_id` on both legs, so the lots carry across accounts intact
 *   instead of being retired here and re-opened at market value over there.
 *   This is the answer that actually improves cost basis.
 * - `left_control` — it really did leave the portfolio: sold off-platform,
 *   gifted, spent. Realizing at market is correct for this row — the change is
 *   that somebody chose it.
 * - `untracked` — still the user's money, in an account Scani cannot see (a
 *   cold wallet, an exchange we have no key for). Not a disposal, so nothing
 *   is realized.
 *
 * There is deliberately no "not sure" value. Not answering is already
 * representable — it is `NULL` — and it is the state the row is in.
 */
export const TRANSFER_REVIEW_DECISIONS = ['paired', 'left_control', 'untracked'] as const;

export const transferReviewDecisionSchema = z.enum(TRANSFER_REVIEW_DECISIONS);

export type TransferReviewDecision = (typeof TRANSFER_REVIEW_DECISIONS)[number];

/**
 * `ReviewItem.kind` for the transfer queue. Like
 * `DOCUMENT_EXTRACTION_REVIEW_KIND` and for the same reason, it is not a
 * member of `REVIEWABLE_JOB_NAMES`: an unpaired transfer is not a job. The
 * `transfer-linking` cron that would have paired it completes successfully
 * every night — completing is precisely what it does when it gives up on a
 * row — so keying this off job state would report a queue of zero while the
 * queue has contents.
 */
export const TRANSFER_REVIEW_KIND = 'transfer-review';

/**
 * Why the matcher would not take a candidate on its own. This is the field
 * that makes the surface reviewable rather than merely a list: "we are unsure"
 * is not something a person can act on, and "the amounts differ by 3.4%,
 * outside the ±1% we allow for network fees" is.
 *
 * Ordered by how close the candidate came, because that is the order a reader
 * wants them in.
 *
 * - `ambiguous` — it matched, and so did something else. The matcher's own
 *   comment is right that auto-linking the wrong one corrupts cost basis worse
 *   than not linking at all; this is the case it was written for.
 * - `quantity_outside_tolerance` — right time, wrong amount. Usually a fee
 *   larger than the ±1% allowance, which is what an expensive chain or a
 *   fixed-fee withdrawal looks like.
 * - `time_outside_window` — right amount, too far apart. A CEX withdrawal held
 *   for manual approval, or a bridge that took hours.
 * - `both_outside` — neither matched, and it is only on the list because
 *   nothing better is. Shown last, and never pre-selected.
 */
export const TRANSFER_CANDIDATE_REASONS = [
  'ambiguous',
  'quantity_outside_tolerance',
  'time_outside_window',
  'both_outside',
] as const;

export const transferCandidateReasonSchema = z.enum(TRANSFER_CANDIDATE_REASONS);

export type TransferCandidateReason = (typeof TRANSFER_CANDIDATE_REASONS)[number];

/** One side of a possible pair: an inflow that might be the same money. */
export const transferCandidateSchema = z.object({
  transactionId: z.string().uuid(),
  holdingId: z.string().uuid(),
  /** Where it landed, in the words the rest of the app uses. */
  accountName: z.string(),
  institutionName: z.string().nullable(),
  kind: z.string(),
  /** Unsigned, as a Decimal string — the row's own precision, not a float. */
  quantity: z.string(),
  occurredAt: z.string(),
  reason: transferCandidateReasonSchema,
  /**
   * Signed, as a percentage of the outflow: `+3.4` means the inflow is 3.4%
   * larger. The sign carries information a magnitude does not — an inflow
   * *smaller* than the outflow is the ordinary fee-shaped difference, and a
   * larger one is not, so it deserves a second look.
   */
  quantityDeltaPct: z.number(),
  /** Signed milliseconds: positive when the inflow landed after the outflow. */
  timeDeltaMs: z.number(),
  /** True when this candidate is inside the matcher's own ±1% / ±30min box —
   *  i.e. it would have been auto-linked had it been the only one. */
  withinStrictTolerance: z.boolean(),
});

export type TransferCandidate = z.infer<typeof transferCandidateSchema>;

/** An unpaired outflow, with everything needed to judge it. */
export const pendingTransferReviewSchema = z.object({
  transactionId: z.string().uuid(),
  holdingId: z.string().uuid(),
  tokenSymbol: z.string(),
  tokenName: z.string().nullable(),
  accountName: z.string(),
  institutionName: z.string().nullable(),
  kind: z.string(),
  quantity: z.string(),
  occurredAt: z.string(),
  counterparty: z.string().nullable(),
  description: z.string().nullable(),
  /**
   * What realizing this row at market value would book as a gain, in the
   * user's base currency — `null` when no price can be resolved at
   * `occurredAt`, which is its own kind of answer.
   *
   * It is the reason to care, so it is on the row rather than behind a tap:
   * without it the queue is a list of chores, and with it the reader can see
   * that answering the top three items is most of the error.
   */
  marketValueInBase: z.string().nullable(),
  baseCurrencyCode: z.string(),
  candidates: z.array(transferCandidateSchema),
});

export type PendingTransferReview = z.infer<typeof pendingTransferReviewSchema>;
