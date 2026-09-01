import { z } from 'zod';

/**
 * Job kinds whose successful result is a proposal the user still has to
 * confirm, not a finished action. Single source of truth: the backend
 * filters the review feed by it, the frontend counts the badge by it, and
 * the renderer registry keys off it. Adding a reviewable kind means adding
 * it here and registering a renderer — nothing else.
 *
 * wallet-import: the worker writes the picker payload, not holdings directly.
 * The user can prune dust / scam tokens before they count toward portfolio totals.
 */
export const REVIEWABLE_JOB_NAMES = ['screenshot-parse', 'file-import', 'wallet-import'] as const;

export function isReviewableJobName(name: string): boolean {
  return (REVIEWABLE_JOB_NAMES as readonly string[]).includes(name);
}

/**
 * `ReviewItem.kind` for a pending invoice extraction. Deliberately NOT a
 * member of `REVIEWABLE_JOB_NAMES` — that list gates `UserJobRepository
 * .findPendingReview`'s `job_name IN (...)` filter and `isReviewableJobName`
 * (the /jobs page's per-job "Needs review" badge), both of which key off
 * `user_jobs.job_name`. An extraction isn't a job: `document-parse` can
 * complete (and drop out of `user_jobs` review-eligibility entirely — it's
 * not in `REVIEWABLE_JOB_NAMES` either) while the invoices it produced stay
 * reviewable for as long as their own `document_extractions.review_state`
 * says `pending`, tracked independently of the job that created them. Two
 * different rows own two different "still needs a decision" facts; folding
 * this kind into the job list would make one collector answer for both.
 */
export const DOCUMENT_EXTRACTION_REVIEW_KIND = 'document-extraction';

/**
 * How a review ended. Both outcomes clear the item from the queue; only
 * one of them wrote anything.
 *
 * Before SC-138 there was no `discarded` and therefore no way out of the
 * review queue that did not import — the only writer of `action_taken_at`
 * was a successful `createHoldingsBatch`, so a junk upload sat in the feed
 * forever and the badge stopped meaning anything. The document-extraction
 * surface already had Approve/Reject; this is the same idea on the job
 * side, recorded rather than inferred so the job page cannot later claim
 * a discarded parse was imported.
 */
export const REVIEW_OUTCOMES = ['imported', 'discarded'] as const;

export const reviewOutcomeSchema = z.enum(REVIEW_OUTCOMES);

export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/**
 * What a review row **is**, in operands — never in a sentence (SC-371).
 *
 * `title` and `subtitle` used to be free text, assembled on the server: the
 * job's English name, `` `${name} failed` ``, a literal `'Invoice extracted'`,
 * and whole pluralised sentences from `reviewSummary.ts` (now `reviewDetail.ts`). Both frontends
 * printed them verbatim, so the same job read `t('v3.jobs.label.walletImport')`
 * on /jobs and the server's `'Wallet import'` on /review, and translating the
 * frontend could not reach the second one. There is no `t()` on the server and
 * there never will be — the API and the worker import this package — so the
 * only place the naming can happen is the client, and the only thing the wire
 * can carry is what the row is made of.
 *
 * It is also why the amount below is a decimal **string**: the extraction row
 * used to spell its figure into the subtitle as `Albert Heijn — 87.31 EUR`,
 * and v3 pulled it back out with a regex over that English. A figure that
 * survives a round trip through prose is a figure waiting to be misread the
 * first time the prose changes.
 */
export const reviewLabelSchema = z.discriminatedUnion('code', [
  /** A completed job whose result is waiting to be confirmed. */
  z.object({ code: z.literal('job'), jobName: z.string().min(1) }),
  /** A job the queue has given up on (SC-153). */
  z.object({ code: z.literal('jobFailed'), jobName: z.string().min(1) }),
  z.object({ code: z.literal('invoiceExtracted') }),
  z.object({ code: z.literal('transfersToConfirm') }),
  /** Unexplained balance changes waiting to be explained (SC-501). */
  z.object({ code: z.literal('balanceChangesToExplain') }),
]);

export type ReviewLabel = z.infer<typeof reviewLabelSchema>;

/**
 * The row facts `describeJobFailure` reads, forwarded rather than rendered.
 *
 * The dead-job row's second line is `describeJobFailure(...).sentence`, and
 * that describer lives in this package precisely so the server, v2 and v3
 * cannot disagree about a failure. Sending the facts instead of the sentence
 * keeps that single source and moves the call to the side that has a `t()`:
 * whenever the describer's own English becomes keys (SC-369 group 3), /review
 * inherits it with no second change here.
 *
 * Structurally typed against `JobFailureFacts` rather than importing its shape
 * — one direction of dependency, and `job-failure.ts` stays untouched.
 */
export const reviewJobFailureFactsSchema = z.object({
  state: z.string(),
  /** A `Date` on the server, the ISO string it serialises to on the client —
   *  this router runs without a transformer, and `describeJobFailure` reads
   *  the field for truthiness alone, so both are the same fact. */
  deadAt: z.union([z.date(), z.string()]).nullish(),
  failureReason: z.string().nullish(),
  attemptsMade: z.number().nullish(),
  attemptsAllowed: z.number().nullish(),
});

/**
 * What the row contains, for the second line. One variant per producer, each
 * pinned to the operands that producer actually has — the counts, the symbols,
 * the wallet's own label. The sentence they used to be assembled into is the
 * client's business now.
 *
 * `symbols` arrives whole and uncapped: which three to show and how to say
 * "+3" is a decision about a 390px row, not about the import.
 */
export const reviewDetailSchema = z.discriminatedUnion('code', [
  z.object({
    code: z.literal('parsedHoldings'),
    holdings: z.number().int().nonnegative(),
    /** Distinct, in first-seen order. Empty when nothing was named. */
    symbols: z.array(z.string().min(1)),
  }),
  z.object({
    code: z.literal('transactionsNeedCurrency'),
    transactions: z.number().int().nonnegative(),
    /** As the worker recorded it (`csv`, `ofx`); the client cases it. */
    fileType: z.string().min(1).optional(),
  }),
  z.object({
    code: z.literal('walletCandidates'),
    walletLabel: z.string().min(1).optional(),
    candidates: z.number().int().nonnegative(),
    chains: z.number().int().nonnegative(),
  }),
  z.object({ code: z.literal('vendor'), name: z.string().min(1) }),
  z.object({
    code: z.literal('unpairedTransfers'),
    transfers: z.number().int().nonnegative(),
  }),
  /**
   * Balance changes the ledger cannot explain (SC-501). A count, like the
   * transfers row above and for the same reason — the queue is unbounded and
   * every item points at the same page.
   */
  z.object({
    code: z.literal('unexplainedBalanceChanges'),
    changes: z.number().int().nonnegative(),
  }),
  z.object({ code: z.literal('jobFailure'), facts: reviewJobFailureFactsSchema }),
]);

export type ReviewDetail = z.infer<typeof reviewDetailSchema>;

/** A figure, not a phrase. The value stays a decimal string end to end. */
export const reviewAmountSchema = z.object({
  value: z.string().min(1),
  currency: z.string().length(3),
});

export type ReviewAmount = z.infer<typeof reviewAmountSchema>;

export const reviewItemSchema = z.object({
  /** Source-prefixed so ids stay unique once non-job sources join. */
  id: z.string().min(1),
  kind: z.string().min(1),
  label: reviewLabelSchema,
  detail: reviewDetailSchema.optional(),
  amount: reviewAmountSchema.optional(),
  /**
   * How many things actually wait behind this row (SC-860).
   *
   * **A row is not always one thing.** Three of the feed's collectors emit a
   * row per record and carry `1`; the two whose queue is unbounded emit ONE
   * row for the whole queue and carry its size — `unpairedTransfers` and
   * `unexplainedBalanceChanges`, whose `detail` already holds the same
   * figure for the sentence the client renders.
   *
   * Until this field existed nothing on the wire said so, and the nav badge
   * read `items.length`: 200 unpaired transfers plus 30 unexplained balance
   * changes announced themselves as **2**. Aggregating stays right for the
   * FEED — the queue is unbounded and every item points at the same page, so
   * enumerating it would bury the three imports that each point somewhere
   * different. The badge answers a different question, "how much is waiting
   * on me", so it sums this instead of counting rows (`reviewBadgeCount`).
   *
   * Required rather than defaulted to 1, on purpose: a collector added later
   * that aggregates and forgets to say so fails this schema, where a default
   * would silently weigh its whole queue as one and reproduce the bug.
   */
  represents: z.number().int().positive(),
  createdAt: z.date(),
  href: z.string().min(1),
});

export type ReviewItem = z.infer<typeof reviewItemSchema>;

/**
 * "How much is waiting on me" — the number the nav badge, the home screen's
 * attention row and the More drawer all show.
 *
 * It lives here rather than at any of those call sites so there is exactly
 * one summing rule, for the same reason `useReviewFeed` is one hook: the
 * badge and the page must not be able to disagree. Structurally typed on
 * `represents` alone so it takes both the server's `ReviewItem` and the
 * serialised row the client holds, whose `createdAt` is an ISO string.
 */
export function reviewBadgeCount(items: readonly { represents: number }[]): number {
  return items.reduce((total, item) => total + item.represents, 0);
}
