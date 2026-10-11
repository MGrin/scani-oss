import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { applyJobEvent, applyJobPoll, EMPTY_JOB_STATUS } from '../../../src/v3/lib/jobs';

/**
 * A realtime `failed` describes one attempt, and a retry may still succeed.
 * `useJobStatus` latched it as final, so the retry's events were dropped and
 * every caller stopped listening: a refresh that succeeded on its second try
 * showed an error toast and refreshed nothing (SC-1599, from the SC-1598
 * liveness audit).
 */

const failedAttempt = (made: number, allowed: number) =>
  applyJobEvent(EMPTY_JOB_STATUS, {
    state: 'failed',
    error: 'Provider timed out',
    attemptsMade: made,
    attemptsAllowed: allowed,
  });

describe('a failed attempt with attempts left (SC-1599)', () => {
  test('is not a final failure', () => {
    expect(failedAttempt(1, 3).finalFailure).toBe(false);
  });

  test("the retry's active event is applied rather than dropped", () => {
    const next = applyJobEvent(failedAttempt(1, 3), { state: 'active' });
    expect(next.state).toBe('active');
  });

  test('a retry that then completes reads completed', () => {
    const retried = applyJobEvent(failedAttempt(1, 3), { state: 'active' });
    const done = applyJobEvent(retried, { state: 'completed', result: { ok: true } });
    expect(done.state).toBe('completed');
    expect(done.finalFailure).toBe(false);
  });

  test('a poll that finds the retry delayed reads queued', () => {
    expect(applyJobPoll(failedAttempt(1, 3), { state: 'delayed' }).state).toBe('queued');
  });
});

describe('a final failure (SC-1599)', () => {
  test('the last attempt failing is final', () => {
    expect(failedAttempt(3, 3).finalFailure).toBe(true);
  });

  test('the queue saying failed is final: BullMQ says so only once attempts are spent', () => {
    expect(applyJobPoll(EMPTY_JOB_STATUS, { state: 'failed' }).finalFailure).toBe(true);
  });

  test('control: a final failure still latches against a late active event', () => {
    expect(applyJobEvent(failedAttempt(3, 3), { state: 'active' }).state).toBe('failed');
  });

  test('control: a completed job still latches against a late active event', () => {
    const done = applyJobEvent(EMPTY_JOB_STATUS, { state: 'completed' });
    expect(applyJobEvent(done, { state: 'active' }).state).toBe('completed');
  });
});
