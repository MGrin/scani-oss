import { describe, expect, it, mock } from 'bun:test';
import { PORTFOLIO_HISTORY_BACKFILL, PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '@scani/jobs';
import {
  LOCK_HELD_RETRY_DELAY_MS,
  LOCK_HELD_RETRY_REQUEST_ID,
  scheduleLockHeldRetry,
} from '../../src/processors/portfolio-history-backfill';

describe('scheduleLockHeldRetry', () => {
  it('enqueues a delayed backfill with the fixed retry requestId', async () => {
    const add = mock(async () => 'job-id-stub');
    await scheduleLockHeldRetry('user-1', { add });

    expect(add).toHaveBeenCalledTimes(1);
    const [descriptor, payload, opts] = add.mock.calls[0]!;
    expect(descriptor).toBe(PORTFOLIO_HISTORY_BACKFILL);
    expect(payload).toEqual({
      userId: 'user-1',
      requestId: LOCK_HELD_RETRY_REQUEST_ID,
      tokenIds: [],
      lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
    });
    expect(opts).toEqual({ delay: LOCK_HELD_RETRY_DELAY_MS });
  });

  it('produces a deterministic jobId per user so concurrent skipped runs dedup', () => {
    const jobIdA = PORTFOLIO_HISTORY_BACKFILL.computeJobId({
      userId: 'user-1',
      requestId: LOCK_HELD_RETRY_REQUEST_ID,
      tokenIds: [],
      lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
    });
    const jobIdB = PORTFOLIO_HISTORY_BACKFILL.computeJobId({
      userId: 'user-1',
      requestId: LOCK_HELD_RETRY_REQUEST_ID,
      tokenIds: [],
      lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
    });
    expect(jobIdA).toBe(jobIdB);

    const otherUser = PORTFOLIO_HISTORY_BACKFILL.computeJobId({
      userId: 'user-2',
      requestId: LOCK_HELD_RETRY_REQUEST_ID,
      tokenIds: [],
      lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
    });
    expect(otherUser).not.toBe(jobIdA);
  });
});
