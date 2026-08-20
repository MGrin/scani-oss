import { describe, expect, test } from 'bun:test';
import { describeJobFailure, isJobAwaitingFailureDecision } from '../../src/dtos/job-failure';

// The whole point of SC-153 lives in this function: `state = 'failed'` was
// written on every failed attempt, on terminal death and on cancellation
// alike, so three situations with three different next steps rendered as one
// red chip. Each case below is one of those situations, and the assertion that
// matters most is `willRetry` — the question the old chip could not answer.
//
// The assertions are on the CODE and its operands, not on a sentence: this
// package has no `t()` and stopped rendering prose in SC-424. What the codes
// are called on screen is asserted where the naming lives —
// `apps/frontend/app/tests/v3/lib/job-failure-text.test.ts`.

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
    expect(described).toMatchObject({ code: 'retrying', attemptsMade: 1, attemptsAllowed: 3 });
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
    expect(described).toMatchObject({ code: 'exhausted', attemptsAllowed: 3 });
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
    // Not `exhausted`: that code carries `attemptsAllowed` into "tried 3
    // times", which would be false — 1 attempt ran and the other two were
    // never used.
    expect(described?.code).toBe('unrecoverable');
  });

  test('a job that never reached the queue says so, and says nothing ran', () => {
    const described = describeJobFailure({
      state: 'failed',
      deadAt: new Date(),
      failureReason: 'never_delivered',
      attemptsMade: 0,
      attemptsAllowed: 3,
    });
    expect(described?.code).toBe('neverDelivered');
    expect(described?.willRetry).toBe(false);
  });

  test('a cancellation is not reported back to the user as a failure', () => {
    const described = describeJobFailure({
      state: 'failed',
      deadAt: new Date(),
      failureReason: 'cancelled',
      attemptsMade: 1,
      attemptsAllowed: 3,
    });
    expect(described?.code).toBe('cancelled');
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
    expect(described?.code).toBe('settling');
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
    expect(described?.code).toBe('notQueued');
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
    expect(described?.code).toBe('settling');
  });

  test('a describer that renders no prose cannot leak English to a translator', () => {
    // The regression SC-424 is about: every value this returns has to be a
    // code, a number or a boolean. A string operand added later is a sentence
    // fragment in the making, and this package is where no `t()` can reach it.
    const shapes = [
      { state: 'failed', deadAt: new Date(), failureReason: 'cancelled' },
      { state: 'failed', deadAt: new Date(), failureReason: 'never_delivered' },
      { state: 'failed', deadAt: new Date(), failureReason: 'unrecoverable' },
      { state: 'failed', deadAt: new Date(), attemptsAllowed: 3, attemptsMade: 3 },
      { state: 'failed', deadAt: new Date(), attemptsAllowed: 1, attemptsMade: 1 },
      { state: 'failed', deadAt: null, attemptsMade: 1, attemptsAllowed: 3, queueHasJob: false },
      { state: 'failed', deadAt: null, attemptsMade: 1, attemptsAllowed: 3 },
      { state: 'failed', deadAt: null, attemptsMade: 3, attemptsAllowed: 3 },
    ];
    const codes = new Set<string>();
    for (const facts of shapes) {
      const described = describeJobFailure(facts);
      expect(described).not.toBeNull();
      codes.add(described?.code ?? '');
      for (const [field, value] of Object.entries(described ?? {})) {
        if (field === 'code') continue;
        expect(typeof value).not.toBe('string');
      }
    }
    // Non-vacuous: every branch of the describer is covered above, so a new
    // one that renders prose cannot hide behind an unexercised path.
    expect(codes.size).toBe(8);
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
