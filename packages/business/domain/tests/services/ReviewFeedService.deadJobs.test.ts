import { describe, expect, test } from 'bun:test';
import { DEAD_JOB_REVIEW_KIND, describeJobFailure, reviewItemSchema } from '@scani/shared';
import Container from 'typedi';
import { DocumentExtractionRepository } from '../../src/repositories/DocumentExtractionRepository';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { ReviewFeedService } from '../../src/services/ReviewFeedService';
import { TransferReviewService } from '../../src/services/TransferReviewService';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

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
    expect(items[0]?.label).toEqual({ code: 'jobFailed', jobName: 'wallet-import' });
    expect(items[0]?.href).toBe('/jobs/job-1');
  });

  /**
   * The facts, not the sentence (SC-371).
   *
   * `describeJobFailure` is the one description of a failure and it already
   * runs in both frontends, so what this feed owes the client is what the
   * describer reads — forwarding its output instead would have been a copy of
   * that English no `t()` could reach, in the row whose whole job is to
   * explain something that went wrong.
   */
  test('the row carries what describeJobFailure reads, not what it said', async () => {
    const items = await makeService([deadJob()]).listPending('user-1');
    const detail = items[0]?.detail;

    expect(detail?.code).toBe('jobFailure');
    expect(detail).toEqual({
      code: 'jobFailure',
      facts: {
        state: 'failed',
        deadAt: new Date('2026-08-14T12:00:00Z'),
        failureReason: 'retries_exhausted',
        attemptsMade: 3,
        attemptsAllowed: 3,
      },
    });
    // And that the shared describer reads them into the terminal code — the
    // naming is the client's (SC-424), the classification is still one.
    expect(
      describeJobFailure(detail?.code === 'jobFailure' ? detail.facts : { state: 'x' })?.code
    ).toBe('exhausted');
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

  test('a job that never reached the queue is forwarded as never delivered', async () => {
    const items = await makeService([
      deadJob({ failureReason: 'never_delivered', attemptsMade: 0 }),
    ]).listPending('user-1');
    const detail = items[0]?.detail;
    expect(detail?.code === 'jobFailure' && detail.facts.failureReason).toBe('never_delivered');
    // Which is what makes the reader's copy say it — the describer is shared.
    expect(
      describeJobFailure(detail?.code === 'jobFailure' ? detail.facts : { state: 'x' })?.code
    ).toBe('neverDelivered');
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
