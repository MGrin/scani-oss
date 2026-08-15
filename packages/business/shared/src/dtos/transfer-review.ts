import { z } from 'zod';
import { Decimal } from '../decimal';

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
 * The marker `holding_transactions.transfer_review` carries when the answer is
 * more than one of the three above (SC-181).
 *
 * It is deliberately NOT a member of `TRANSFER_REVIEW_DECISIONS`: nobody taps
 * "split", and no branch of `CostBasisService` may treat it as an outcome. It
 * means "the answer is in `transfer_review_split`, go and read it", and it
 * exists so the queue predicate — `transfer_review IS NULL` — keeps working
 * unchanged. A split row is answered; it leaves the queue; the count still
 * reaches zero.
 */
export const TRANSFER_REVIEW_SPLIT = 'split';

/**
 * The most portions one outflow can be divided into.
 *
 * Three, because there are three answers and a portion per answer is the whole
 * of what can be said — two portions carrying the same decision are one
 * portion written twice, and `transferReviewSplitSchema` rejects them.
 */
export const MAX_TRANSFER_REVIEW_PORTIONS = 3;

/**
 * One share of an outflow, and what happened to it.
 *
 * `quantity` is unsigned and in the token's own units — the same units as the
 * amount on the row being answered, because that is the number on the reader's
 * screen. A 4,000 USD withdrawal split 3,500 / 500 is two portions of 3500 and
 * 500, not a percentage and not a base-currency amount: converting either way
 * would make the sum the user is being asked to check depend on a price
 * lookup.
 */
export const transferReviewSplitPortionSchema = z.object({
  decision: transferReviewDecisionSchema,
  /** Positive Decimal string. Zero is not a portion — it is the portion not
   *  being used, which is expressed by leaving it out. */
  quantity: z.string().refine((v) => isPositiveDecimal(v), {
    message: 'Each part needs an amount greater than zero',
  }),
  /** Required on the `paired` portion, meaningless on the others. */
  matchTransactionId: z.string().uuid().optional(),
});

export type TransferReviewSplitPortion = z.infer<typeof transferReviewSplitPortionSchema>;

/**
 * A whole answer, divided.
 *
 * Four rules, all enforced here rather than in the form, because a split that
 * does not add up is a new way to be wrong about money and the form is not the
 * only caller:
 *
 * 1. **At least two portions.** One portion is a whole answer and must be
 *    written as one, or the same state has two representations and every
 *    reader has to handle both.
 * 2. **Each decision at most once.** See `MAX_TRANSFER_REVIEW_PORTIONS`.
 * 3. **At most one `paired` portion**, and it needs its deposit. This is a
 *    real limit, not an oversight: pairing writes a shared
 *    `transfer_group_id`, that is one column on the outflow row, and
 *    `buildTransferComponents` walks it to decide which holdings share a lot
 *    ledger. A second pairing would need a second group id in a place the
 *    component builder does not look, and the destination holding would then
 *    be walked on its own and open a fresh market-value lot — the exact defect
 *    SC-150 closed. A withdrawal spread across two *tracked* destinations is
 *    therefore still one question this cannot answer; it is rare next to the
 *    reported shape (one tracked or untracked destination plus a fee or a
 *    disposal) and it is honest to refuse it rather than half-record it.
 * 4. **The sum is checked against the transaction**, which this schema cannot
 *    see. `splitSumMatches` does it, at the API boundary and in the form.
 */
export const transferReviewSplitSchema = z
  .array(transferReviewSplitPortionSchema)
  .min(2, { message: 'A split needs at least two parts' })
  .max(MAX_TRANSFER_REVIEW_PORTIONS)
  .superRefine((portions, ctx) => {
    const seen = new Set<TransferReviewDecision>();
    for (const portion of portions) {
      if (seen.has(portion.decision)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Each outcome can only appear once in a split',
        });
        return;
      }
      seen.add(portion.decision);
    }
    const paired = portions.filter((p) => p.decision === 'paired');
    if (paired.length > 0 && !paired[0]?.matchTransactionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Pairing part of a transfer requires the matching deposit',
        path: [portions.findIndex((p) => p.decision === 'paired'), 'matchTransactionId'],
      });
    }
  });

export type TransferReviewSplit = z.infer<typeof transferReviewSplitSchema>;

/**
 * Does this split account for exactly the transaction it answers?
 *
 * Exact, on Decimal, with no tolerance. A tolerance here would be a second
 * matcher — the thing SC-150 exists to stop trusting — and the amount is
 * arithmetic the reader can do: the form shows what is left to allocate and
 * offers the remainder as a tap, so hitting the total by hand is one number
 * typed, not two.
 */
export function splitSumMatches(split: TransferReviewSplit, quantity: string): boolean {
  return splitTotal(split).eq(new Decimal(quantity).abs());
}

/** The portions' sum, unsigned. Exported for the form's "left to allocate". */
export function splitTotal(split: readonly TransferReviewSplitPortion[]): Decimal {
  return split.reduce((sum, p) => sum.add(new Decimal(p.quantity).abs()), new Decimal(0));
}

/**
 * What a person can say about an outflow they have already answered — the
 * "Answered" half of the queue (SC-181).
 *
 * Deliberately thinner than `PendingTransferReview`: no candidate search and
 * no price lookup, both of which are per-row round trips that the pending list
 * pays because the reader is about to make a judgement with them. Here the
 * reader is looking for a row they already decided, and the only action is to
 * reopen it — after which it is a pending row and carries everything again.
 */
export const answeredTransferReviewSchema = z.object({
  transactionId: z.string().uuid(),
  holdingId: z.string().uuid(),
  tokenSymbol: z.string(),
  accountName: z.string(),
  institutionName: z.string().nullable(),
  kind: z.string(),
  quantity: z.string(),
  occurredAt: z.string(),
  counterparty: z.string().nullable(),
  /** One of `TRANSFER_REVIEW_DECISIONS`, or `TRANSFER_REVIEW_SPLIT`. */
  decision: z.string(),
  /** Present only on a split row. */
  split: transferReviewSplitSchema.nullable(),
  reviewedAt: z.string().nullable(),
});

export type AnsweredTransferReview = z.infer<typeof answeredTransferReviewSchema>;

function isPositiveDecimal(value: string): boolean {
  try {
    const d = new Decimal(value);
    return d.isFinite() && d.gt(0);
  } catch {
    return false;
  }
}

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
