import { describe, expect, test } from 'bun:test';
import { describeJobFailure, isJobAwaitingFailureDecision } from '../../src/dtos/job-failure';

// The whole point of SC-153 lives in this function: `state = 'failed'` was
// written on every failed attempt, on terminal death and on cancellation
// alike, so three situations with three different next steps rendered as one
// red chip. Each case below is one of those situations, and the assertion that
// matters most is `willRetry` — the question the old chip could not answer.

describe('describeJobFailure', () => {
  test('a job that has not failed has no failure to describe', () => {
    expect(describeJobFailure({ state: 'active' })).toBeNull();
    expect(describeJobFailure({ state: 'completed' })).toBeNull();
    expect(describeJobFailure({ state: 'queued' })).toBeNull();
  });

  test('mid-retry reads as retrying, not as failed', () => {
    const described = describeJobFailure({
      state: 'failed',
      deadAt: null,
      attemptsMade: 1,
      attemptsAllowed: 3,
    });
    expect(described?.willRetry).toBe(true);
    expect(described?.label).toBe('Retrying (1 of 3)');
    // Nothing is being asked of the user while the queue is still working.
    expect(described?.retryWorthOffering).toBe(false);
  });

  test('dead reads as terminal even though the row still says failed', () => {
    const described = describeJobFailure({
      state: 'failed',
      deadAt: new Date('2026-08-14T12:00:00Z'),
      failureReason: 'retries_exhausted',
      attemptsMade: 3,
      attemptsAllowed: 3,
    });
    expect(described?.willRetry).toBe(false);
    expect(described?.label).toBe("Failed — won't retry");
    expect(described?.sentence).toContain('tried 3 times');
  });

  test('an unrecoverable failure does not claim the attempts were spent', () => {
    // BullMQ skips the remaining attempts by design here, so "tried 3 times"
    // would be false — 1 attempt ran and the other two were never used.
    const described = describeJobFailure({
      state: 'failed',
      deadAt: new Date(),
      failureReason: 'unrecoverable',
      attemptsMade: 1,
      attemptsAllowed: 3,
    });
    expect(described?.willRetry).toBe(false);
    expect(described?.sentence).not.toContain('3 times');
    expect(described?.sentence).toContain('will not fix');
  });

  test('a job that never reached the queue says so, and says nothing ran', () => {
    const described = describeJobFailure({
      state: 'failed',
      deadAt: new Date(),
      failureReason: 'never_delivered',
      attemptsMade: 0,
      attemptsAllowed: 3,
    });
    expect(described?.label).toBe('Never started');
    expect(described?.willRetry).toBe(false);
    expect(described?.sentence).toContain('nothing was changed');
  });

  test('a cancellation is not reported back to the user as a failure', () => {
    const described = describeJobFailure({
      state: 'failed',
      deadAt: new Date(),
      failureReason: 'cancelled',
      attemptsMade: 1,
      attemptsAllowed: 3,
    });
    expect(described?.label).toBe('Cancelled');
    expect(described?.retryWorthOffering).toBe(false);
  });

  test('out of attempts but not yet stamped dead claims neither retry nor death', () => {
    // The gap between the processor writing the attempt and BullMQ declaring
    // the job over. Claiming "retrying" would be the lie the ticket is about;
    // claiming "won't retry" would be premature.
    const described = describeJobFailure({
      state: 'failed',
      deadAt: null,
      attemptsMade: 3,
      attemptsAllowed: 3,
    });
    expect(described?.label).toBe('Failed');
    expect(described?.willRetry).toBe(false);
  });

  test('counters do not promise a retry the queue cannot make', () => {
    // A worker replaced mid-backoff leaves a row reading "attempt 1 of 3"
    // with nothing in Redis behind it. The counters say a retry is due; the
    // queue is the thing that would have to run it, and it has nothing.
    const described = describeJobFailure({
      state: 'failed',
      deadAt: null,
      attemptsMade: 1,
      attemptsAllowed: 3,
      queueHasJob: false,
    });
    expect(described?.willRetry).toBe(false);
    expect(described?.sentence).toContain('no further attempt is queued');
  });

  test('a confirmed queue entry still reads as retrying', () => {
    const described = describeJobFailure({
      state: 'failed',
      deadAt: null,
      attemptsMade: 1,
      attemptsAllowed: 3,
      queueHasJob: true,
    });
    expect(described?.willRetry).toBe(true);
  });

  test('a single-attempt job that failed is not described as retrying', () => {
    const described = describeJobFailure({
      state: 'failed',
      deadAt: null,
      attemptsMade: 1,
      attemptsAllowed: 1,
    });
    expect(described?.willRetry).toBe(false);
  });
});

describe('isJobAwaitingFailureDecision', () => {
  test('a dead job the user has not acted on is waiting on them', () => {
    expect(
      isJobAwaitingFailureDecision({
        state: 'failed',
        deadAt: new Date(),
        failureReason: 'retries_exhausted',
        actionTakenAt: null,
      })
    ).toBe(true);
  });

  test('a dismissed one is not', () => {
    expect(
      isJobAwaitingFailureDecision({
        state: 'failed',
        deadAt: new Date(),
        failureReason: 'retries_exhausted',
        actionTakenAt: new Date(),
      })
    ).toBe(false);
  });

  test('a cancellation never asks the user about itself', () => {
    expect(
      isJobAwaitingFailureDecision({
        state: 'failed',
        deadAt: new Date(),
        failureReason: 'cancelled',
        actionTakenAt: null,
      })
    ).toBe(false);
  });

  test('a job merely mid-retry is not waiting on anyone', () => {
    expect(
      isJobAwaitingFailureDecision({
        state: 'failed',
        deadAt: null,
        attemptsMade: 1,
        attemptsAllowed: 3,
        actionTakenAt: null,
      })
    ).toBe(false);
  });
});
