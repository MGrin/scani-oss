import { describe, expect, test } from 'bun:test';
import Container from 'typedi';
import { DocumentExtractionRepository } from '../../src/repositories/DocumentExtractionRepository';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { BalanceGapService } from '../../src/services/holdings/BalanceGapService';
import { ReviewFeedService } from '../../src/services/ReviewFeedService';
import { TransferReviewService } from '../../src/services/TransferReviewService';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * Regression guard for the badge/feed mismatch found during manual testing.
 *
 * The badge used to count reviewable jobs client-side over `jobs.listMine`,
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 * badge is the only affordance telling anyone the page has contents.
 *
 * The feed must never inherit that window. It filters server-side across
 * all of a user's jobs, so an old pending review still surfaces no matter
 * how much recent unrelated job traffic sits in front of it.
 */

function makeService(jobs: unknown[], deadJobs: unknown[] = []): ReviewFeedService {
  Container.set(UserJobRepository, {
    // The real repository filters by kind/state/actionTakenAt in SQL and
    // applies no recency window, so the stub returns whatever it is given.
    findPendingReview: async () => jobs,
    // The dead-job collector (SC-153) queries this too; these suites are
    // about the review half, so it answers empty.
    findDeadUnacknowledged: async () => deadJobs,
  } as unknown as UserJobRepository);
  Container.set(DocumentExtractionRepository, {
    findPendingByUser: async () => [],
  } as unknown as DocumentExtractionRepository);
  Container.set(TransferReviewService, {
    pendingSummary: async () => ({ count: 0, latestCreatedAt: null }),
  } as unknown as TransferReviewService);
  // The balance-gap collector (SC-501) is on the same feed. These suites are
  // about the other producers, so it answers empty — stubbed rather than left
  // to resolve, because a class-field dep that reaches a real repository here
  // fails against the database instead of failing as a missing stub.
  Container.set(BalanceGapService, {
    pendingSummary: async () => ({ count: 0, latestAt: null }),
  } as unknown as BalanceGapService);
  const instance = new ReviewFeedService();
  Container.set(ReviewFeedService, instance);
  return instance;
}

describe('ReviewFeedService — recency window regression', () => {
  test('surfaces a pending review buried behind hundreds of newer jobs', async () => {
    // One genuinely old reviewable job — the shape that vanished from the
    // badge in production data.
    const old = {
      jobId: 'old-screenshot',
      jobName: 'screenshot-parse',
      createdAt: new Date('2026-05-17T16:52:38Z'),
      result: null,
    };

    const svc = makeService([old]);
    const items = await svc.listPending('user-1');

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('job:old-screenshot');
  });

  test('does not cap the feed at a recent-jobs window', async () => {
    // 120 pending reviews spread over a year. Any implementation that
    // sliced a "recent" window would drop the tail.
    const many = Array.from({ length: 120 }, (_, i) => ({
      jobId: `job-${i}`,
      jobName: 'screenshot-parse',
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000),
      result: null,
    }));

    const items = await makeService(many).listPending('user-1');

    expect(items).toHaveLength(120);
    // Oldest must still be present, not truncated away.
    expect(items.map((i) => i.id)).toContain('job:job-0');
  });
});
