import type { DocumentExtraction, UserJob } from '@scani/db/schema';
import {
  DEAD_JOB_REVIEW_KIND,
  DOCUMENT_EXTRACTION_REVIEW_KIND,
  describeJobFailure,
  isJobAwaitingFailureDecision,
  type ReviewItem,
  TRANSFER_REVIEW_KIND,
  userJobTitle,
} from '@scani/shared';
import Container, { Service } from 'typedi';
import { DocumentExtractionRepository } from '../repositories/DocumentExtractionRepository';
import { UserJobRepository } from '../repositories/UserJobRepository';
import { summarisePendingReview } from './reviewSummary';
import { TransferReviewService } from './TransferReviewService';

/**
 * "What is waiting on the user", across every producer.
 *
 * Read-model only: review state stays on the domain row that owns it
 * (`user_jobs.action_taken_at` today), so there is no second copy to
 * drift. New producers add a private collector and concatenate here.
 */
@Service()
export class ReviewFeedService {
  private readonly userJobs = Container.get(UserJobRepository);
  private readonly documentExtractions = Container.get(DocumentExtractionRepository);
  private readonly transferReviews = Container.get(TransferReviewService);

  async listPending(userId: string): Promise<ReviewItem[]> {
    const items = [
      ...(await this.fromJobs(userId)),
      ...(await this.fromDeadJobs(userId)),
      ...(await this.fromExtractions(userId)),
      ...(await this.fromTransfers(userId)),
    ];
    return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private async fromJobs(userId: string): Promise<ReviewItem[]> {
    const jobs = await this.userJobs.findPendingReview(userId);
    return jobs.map((j: UserJob) => ({
      id: `job:${j.jobId}`,
      kind: j.jobName,
      title: userJobTitle(j.jobName),
      subtitle: summarisePendingReview(j.jobName, j.result),
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
      .map((j: UserJob) => {
        const failure = describeJobFailure(j);
        return {
          id: `job-failed:${j.jobId}`,
          kind: DEAD_JOB_REVIEW_KIND,
          title: `${userJobTitle(j.jobName)} failed`,
          subtitle: failure?.sentence,
          createdAt: j.deadAt ?? j.createdAt,
          href: `/jobs/${j.jobId}`,
        };
      });
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
    return extractions.map((e: DocumentExtraction) => ({
      id: `extraction:${e.id}`,
      kind: DOCUMENT_EXTRACTION_REVIEW_KIND,
      title: 'Invoice extracted',
      subtitle: summariseExtraction(e),
      createdAt: e.createdAt,
      href: `/documents/${e.documentId}`,
    }));
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
   */
  private async fromTransfers(userId: string): Promise<ReviewItem[]> {
    const { count, latestCreatedAt } = await this.transferReviews.pendingSummary(userId);
    if (count === 0 || !latestCreatedAt) return [];
    return [
      {
        id: 'transfer-review:pending',
        kind: TRANSFER_REVIEW_KIND,
        title: 'Transfers to confirm',
        subtitle:
          count === 1
            ? '1 transfer out with no matching deposit'
            : `${count} transfers out with no matching deposit`,
        createdAt: latestCreatedAt,
        href: '/review/transfers',
      },
    ];
  }
}

function summariseExtraction(extraction: DocumentExtraction): string | undefined {
  const vendor = extraction.vendorNameRaw.trim();
  const amount =
    extraction.totalAmount && extraction.currencyCode
      ? `${extraction.totalAmount} ${extraction.currencyCode}`
      : (extraction.totalAmount ?? undefined);
  if (vendor && amount) return `${vendor} — ${amount}`;
  return vendor || amount;
}
