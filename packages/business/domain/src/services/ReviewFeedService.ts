import type { DocumentExtraction, UserJob } from '@scani/db/schema';
import { DOCUMENT_EXTRACTION_REVIEW_KIND, type ReviewItem } from '@scani/shared';
import Container, { Service } from 'typedi';
import { DocumentExtractionRepository } from '../repositories/DocumentExtractionRepository';
import { UserJobRepository } from '../repositories/UserJobRepository';
import { summarisePendingReview } from './reviewSummary';

// Kept in step with the frontend's `components/jobs/jobLabels.ts` — the
// same job showing as "Screenshot import" on /review and "Document parse"
// on /jobs reads as two different things to the user.
const JOB_TITLES: Record<string, string> = {
  'screenshot-parse': 'Document parse',
  'file-import': 'File import',
  'wallet-import': 'Wallet import',
};

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

  async listPending(userId: string): Promise<ReviewItem[]> {
    const items = [...(await this.fromJobs(userId)), ...(await this.fromExtractions(userId))];
    return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private async fromJobs(userId: string): Promise<ReviewItem[]> {
    const jobs = await this.userJobs.findPendingReview(userId);
    return jobs.map((j: UserJob) => ({
      id: `job:${j.jobId}`,
      kind: j.jobName,
      title: JOB_TITLES[j.jobName] ?? j.jobName,
      subtitle: summarisePendingReview(j.jobName, j.result),
      createdAt: j.createdAt,
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
    return extractions.map((e: DocumentExtraction) => ({
      id: `extraction:${e.id}`,
      kind: DOCUMENT_EXTRACTION_REVIEW_KIND,
      title: 'Invoice extracted',
      subtitle: summariseExtraction(e),
      createdAt: e.createdAt,
      href: `/documents/${e.documentId}`,
    }));
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
