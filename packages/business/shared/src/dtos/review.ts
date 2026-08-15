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

export const reviewItemSchema = z.object({
  /** Source-prefixed so ids stay unique once non-job sources join. */
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  createdAt: z.date(),
  href: z.string().min(1),
});

export type ReviewItem = z.infer<typeof reviewItemSchema>;
