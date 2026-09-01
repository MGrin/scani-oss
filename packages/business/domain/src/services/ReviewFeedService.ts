import type { DocumentExtraction, UserJob } from '@scani/db/schema';
import {
  BALANCE_GAP_REVIEW_KIND,
  DEAD_JOB_REVIEW_KIND,
  DOCUMENT_EXTRACTION_REVIEW_KIND,
  isJobAwaitingFailureDecision,
  type ReviewAmount,
  type ReviewItem,
  TRANSFER_REVIEW_KIND,
} from '@scani/shared';
import Container, { Service } from 'typedi';
import { DocumentExtractionRepository } from '../repositories/DocumentExtractionRepository';
import { UserJobRepository } from '../repositories/UserJobRepository';
import { BalanceGapService } from './holdings/BalanceGapService';
import { describePendingReview } from './reviewDetail';
import { TransferReviewService } from './TransferReviewService';

/**
 * "What is waiting on the user", across every producer.
 *
 * Read-model only: review state stays on the domain row that owns it
 * (`user_jobs.action_taken_at` today), so there is no second copy to
 * drift. New producers add a private collector and concatenate here.
 *
 * **It emits operands, never prose** (SC-371). Every collector below used to
 * compose the row's two lines in English — a job's name, a count with its own
 * pluralisation, a vendor and a figure joined with an em dash — and both
 * frontends printed the result verbatim, which put a copy of those strings
 * beyond the reach of any translation and of every scanner the i18n epic has.
 * A collector's output is now the facts the row is made of; naming them is the
 * client's half, because the client is the half that has a `t()`.
 */
@Service()
export class ReviewFeedService {
  private readonly userJobs = Container.get(UserJobRepository);
  private readonly documentExtractions = Container.get(DocumentExtractionRepository);
  private readonly transferReviews = Container.get(TransferReviewService);
  private readonly balanceGaps = Container.get(BalanceGapService);

  async listPending(userId: string): Promise<ReviewItem[]> {
    const items = [
      ...(await this.fromJobs(userId)),
      ...(await this.fromDeadJobs(userId)),
      ...(await this.fromExtractions(userId)),
      ...(await this.fromTransfers(userId)),
      ...(await this.fromBalanceGaps(userId)),
    ];
    return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private async fromJobs(userId: string): Promise<ReviewItem[]> {
    const jobs = await this.userJobs.findPendingReview(userId);
    return jobs.map((j: UserJob) => ({
      id: `job:${j.jobId}`,
      kind: j.jobName,
      label: { code: 'job' as const, jobName: j.jobName },
      detail: describePendingReview(j.jobName, j.result),
      represents: 1,
      createdAt: j.createdAt,
      href: `/jobs/${j.jobId}`,
    }));
  }

  /**
   * Jobs the queue has given up on (SC-153).
   *
   * This is the answer to "how does the person whose data is stuck find
   * out". The DLQ already knew, `dlq-depth-probe` already alerted, and the
   * admin app could already inspect and retry — none of which is visible to
   * the user, so a dead job and a running one looked identical to them,
   * permanently. Putting it here rather than in a new channel is the point:
   * this feed is already "what is waiting on you", it already runs
   * server-side across every job rather than the 50 newest, and it already
   * drives the home screen's attention row, the /review page and the tab
   * badge. A failure that reaches none of those has not reached anyone.
   *
   * `createdAt` is the moment of death, not of enqueue — a job that died
   * this morning after being started last week is news today, and sorting
   * it by its birthday would bury it under the week's imports.
   *
   * One row per dead job, unlike the transfer collector's single aggregate
   * row: dead jobs are bounded by how many things the user started, each
   * points at its own detail page with its own error and its own retry, and
   * collapsing them would replace the specific sentence with a count.
   */
  private async fromDeadJobs(userId: string): Promise<ReviewItem[]> {
    const jobs = await this.userJobs.findDeadUnacknowledged(userId);
    return jobs
      .filter((j: UserJob) => isJobAwaitingFailureDecision(j))
      .map((j: UserJob) => ({
        id: `job-failed:${j.jobId}`,
        kind: DEAD_JOB_REVIEW_KIND,
        label: { code: 'jobFailed' as const, jobName: j.jobName },
        // The facts, not the sentence: `describeJobFailure` is the one
        // description of a failure and it already runs in both frontends, so
        // the client calls it with these rather than reading a copy that was
        // rendered here and can no longer be translated.
        detail: {
          code: 'jobFailure' as const,
          facts: {
            state: j.state,
            deadAt: j.deadAt,
            failureReason: j.failureReason,
            attemptsMade: j.attemptsMade,
            attemptsAllowed: j.attemptsAllowed,
          },
        },
        represents: 1,
        createdAt: j.deadAt ?? j.createdAt,
        href: `/jobs/${j.jobId}`,
      }));
  }

  /**
   * Pending invoice extractions — review state lives on the extraction row
   * itself (`document_extractions.review_state`), not on the `document-parse`
   * job that produced it, so this reads straight from
   * `DocumentExtractionRepository` rather than through `UserJobRepository`.
   * See `DOCUMENT_EXTRACTION_REVIEW_KIND` in @scani/shared for why this
   * kind is deliberately absent from `REVIEWABLE_JOB_NAMES`.
   */
  private async fromExtractions(userId: string): Promise<ReviewItem[]> {
    const extractions = await this.documentExtractions.findPendingByUser(userId);
    return extractions.map((e: DocumentExtraction) => {
      const vendor = e.vendorNameRaw.trim();
      return {
        id: `extraction:${e.id}`,
        kind: DOCUMENT_EXTRACTION_REVIEW_KIND,
        label: { code: 'invoiceExtracted' as const },
        detail: vendor ? { code: 'vendor' as const, name: vendor } : undefined,
        amount: extractionAmount(e),
        represents: 1,
        createdAt: e.createdAt,
        href: `/documents/${e.documentId}`,
      };
    });
  }

  /**
   * Unpaired transfers (SC-150) — **one row for the whole queue**, not one per
   * transfer, which is the only collector here that aggregates.
   *
   * Every other producer emits a row per record because those queues are a
   * handful of items and each points at a different surface. This one is
   * unbounded — a heavy-CEX user with years of withdrawals can have hundreds
   * of unpaired outflows, all of which point at the *same* surface — and a
   * feed that is 200 transfer rows and 3 imports has stopped being a list of
   * what needs you. The count is the item; the queue does its own sorting,
   * filtering and search on the page it links to.
   *
   * `createdAt` is when the queue last gained a row, so a fresh unpaired
   * withdrawal floats this to the top of the feed the way a fresh import
   * does. The age of the *oldest* unanswered one belongs on the page, where
   * there is room to say it per row.
   *
   * **The badge does not inherit the collapse** (SC-860). Everything above is
   * an argument about the feed — what a list of what needs you should contain.
   * "How much is waiting on me" is a different question, and answering it with
   * a row count made two hundred unpaired transfers read as `1`. The row
   * carries `represents`, which the badge sums; the feed still shows one row.
   */
  private async fromTransfers(userId: string): Promise<ReviewItem[]> {
    const { count, latestCreatedAt } = await this.transferReviews.pendingSummary(userId);
    if (count === 0 || !latestCreatedAt) return [];
    return [
      {
        id: 'transfer-review:pending',
        kind: TRANSFER_REVIEW_KIND,
        label: { code: 'transfersToConfirm' as const },
        detail: { code: 'unpairedTransfers' as const, transfers: count },
        // The badge sums this where the feed counts rows (SC-860): one row
        // here, `count` things actually waiting.
        represents: count,
        createdAt: latestCreatedAt,
        href: '/review/transfers',
      },
    ];
  }

  /**
   * Unexplained balance changes (SC-501) — **one row for the whole queue**,
   * for the same reason the transfer collector aggregates: the queue is
   * unbounded, every item points at the same page, and a feed that is thirty
   * balance rows and three imports has stopped being a list of what needs
   * you.
   *
   * `createdAt` is the newest gap's closing observation, so a change observed
   * this morning floats this to the top the way a fresh import does. The gap
   * itself may be months old — the interval it closes can be seventy-one days
   * wide — and that age belongs on the page, where there is room to say it
   * per row.
   */
  private async fromBalanceGaps(userId: string): Promise<ReviewItem[]> {
    const { count, latestAt } = await this.balanceGaps.pendingSummary(userId);
    if (count === 0 || !latestAt) return [];
    return [
      {
        id: 'balance-gap:pending',
        kind: BALANCE_GAP_REVIEW_KIND,
        label: { code: 'balanceChangesToExplain' as const },
        detail: { code: 'unexplainedBalanceChanges' as const, changes: count },
        // As in the transfer collector above: one row, `count` things.
        represents: count,
        createdAt: latestAt,
        href: '/review/balances',
      },
    ];
  }
}

/**
 * The figure as the extractor recorded it — a decimal **string**, not a
 * number. It used to be spelled into the subtitle as `87.31 EUR` and pulled
 * back out of that English by a regex in v3; keeping the digits verbatim is
 * what lets both interfaces render the same figure they render today without
 * a float rounding `87.30` down to `87.3` on the way past.
 *
 * A total with no currency code cannot be an amount — there is nothing to say
 * it in — so it is dropped rather than shown bare.
 */
function extractionAmount(extraction: DocumentExtraction): ReviewAmount | undefined {
  if (!extraction.totalAmount || !extraction.currencyCode) return undefined;
  return { value: extraction.totalAmount, currency: extraction.currencyCode };
}
