import { describe, expect, test } from 'bun:test';
import { DEAD_JOB_REVIEW_KIND, reviewItemSchema } from '@scani/shared';
import Container from 'typedi';
import { DocumentExtractionRepository } from '../../src/repositories/DocumentExtractionRepository';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { ReviewFeedService } from '../../src/services/ReviewFeedService';
import { TransferReviewService } from '../../src/services/TransferReviewService';

/**
 * SC-153: a job the queue has given up on has to reach the person whose data
 * it is. The feed is the channel — it drives the home screen's attention row,
 * the /review page and the tab badge — so what this suite protects is that a
 * dead job arrives there, that a job which is merely mid-retry does not, and
 * that the item says what happened rather than "something failed".
 */

function makeService(deadJobs: unknown[], pendingReview: unknown[] = []): ReviewFeedService {
  Container.set(UserJobRepository, {
    findPendingReview: async () => pendingReview,
    findDeadUnacknowledged: async () => deadJobs,
  } as unknown as UserJobRepository);
  Container.set(DocumentExtractionRepository, {
    findPendingByUser: async () => [],
  } as unknown as DocumentExtractionRepository);
  Container.set(TransferReviewService, {
    pendingSummary: async () => ({ count: 0, latestCreatedAt: null }),
  } as unknown as TransferReviewService);
  const instance = new ReviewFeedService();
  Container.set(ReviewFeedService, instance);
  return instance;
}

const deadJob = (over: Record<string, unknown> = {}) => ({
  jobId: 'job-1',
  jobName: 'wallet-import',
  state: 'failed',
  createdAt: new Date('2026-08-10T09:00:00Z'),
  deadAt: new Date('2026-08-14T12:00:00Z'),
  failureReason: 'retries_exhausted',
  attemptsMade: 3,
  attemptsAllowed: 3,
  actionTakenAt: null,
  result: null,
  ...over,
});

describe('ReviewFeedService — dead jobs', () => {
  test('a dead job reaches the feed, named and explained', async () => {
    const items = await makeService([deadJob()]).listPending('user-1');

    expect(items).toHaveLength(1);
    expect(reviewItemSchema.parse(items[0])).toBeTruthy();
    expect(items[0]?.kind).toBe(DEAD_JOB_REVIEW_KIND);
    expect(items[0]?.title).toBe('Wallet import failed');
    expect(items[0]?.subtitle).toContain('will not be tried again');
    expect(items[0]?.href).toBe('/jobs/job-1');
  });

  test('the item is dated by the death, not by the enqueue', async () => {
    // A job started last week and killed this morning is news today. Sorting
    // it by its birthday buries it under the week's imports — which is how it
    // stayed invisible in the first place.
    const items = await makeService([deadJob()]).listPending('user-1');
    expect(items[0]?.createdAt).toEqual(new Date('2026-08-14T12:00:00Z'));
  });

  test('a cancellation never comes back asking about itself', async () => {
    const items = await makeService([
      deadJob({ failureReason: 'cancelled', actionTakenAt: null }),
    ]).listPending('user-1');
    expect(items).toHaveLength(0);
  });

  test('a dismissed failure leaves the feed', async () => {
    const items = await makeService([
      deadJob({ actionTakenAt: new Date('2026-08-14T13:00:00Z') }),
    ]).listPending('user-1');
    expect(items).toHaveLength(0);
  });

  test('a job that is merely mid-retry is not in the feed', async () => {
    // Nothing is waiting on the user: the queue is still working on it. The
    // repository query would not return this row; the collector refuses it a
    // second time so the two cannot drift apart.
    const items = await makeService([
      deadJob({ deadAt: null, failureReason: null, attemptsMade: 1 }),
    ]).listPending('user-1');
    expect(items).toHaveLength(0);
  });

  test('a job that never reached the queue says nothing ran', async () => {
    const items = await makeService([
      deadJob({ failureReason: 'never_delivered', attemptsMade: 0 }),
    ]).listPending('user-1');
    expect(items[0]?.subtitle).toContain('never ran');
  });

  test('dead jobs and pending reviews share one feed, newest first', async () => {
    const items = await makeService(
      [deadJob({ deadAt: new Date('2026-08-14T12:00:00Z') })],
      [
        {
          jobId: 'job-2',
          jobName: 'screenshot-parse',
          createdAt: new Date('2026-08-14T08:00:00Z'),
          result: null,
        },
      ]
    ).listPending('user-1');

    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe('job-failed:job-1');
    expect(items[1]?.id).toBe('job:job-2');
  });
});
