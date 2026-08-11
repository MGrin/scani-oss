import type { UserJob } from '@scani/db/schema';
import type { ReviewItem } from '@scani/shared';
import Container, { Service } from 'typedi';
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

  async listPending(userId: string): Promise<ReviewItem[]> {
    const items = [...(await this.fromJobs(userId))];
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
}
