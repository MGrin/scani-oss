import { describe, expect, it, mock } from 'bun:test';
import {
  PORTFOLIO_HISTORY_BACKFILL,
  PORTFOLIO_HISTORY_CHUNK_DAYS,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
  type PortfolioHistoryRollupProgress,
} from '@scani/jobs';
import {
  CHUNK_LOCK_MAX_WAITS,
  CHUNK_LOCK_WAIT_MS,
  LOCK_HELD_RETRY_DELAY_MS,
  LOCK_HELD_RETRY_REQUEST_ID,
  resumableProgress,
  runChunkedRollup,
  scheduleLockHeldRetry,
} from '../../src/processors/portfolio-history-backfill';

describe('scheduleLockHeldRetry', () => {
  it('enqueues a delayed backfill with the fixed retry requestId', async () => {
    const add = mock(
      async (_descriptor: unknown, _payload: unknown, _opts?: unknown) => 'job-id-stub'
    );
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

describe('runChunkedRollup (SC-1283)', () => {
  const anchor = '2026-09-21T01:56:00.000Z';
  type Call = { from: number; to: number; runStart: string };

  function rollupRecorder(opts: { failAtFrom?: number; skipTimes?: number } = {}) {
    const calls: Call[] = [];
    let skipsLeft = opts.skipTimes ?? 0;
    const rollup = async (o: { runStart: Date; dayOffsets: { from: number; to: number } }) => {
      calls.push({ ...o.dayOffsets, runStart: o.runStart.toISOString() });
      if (o.dayOffsets.from === opts.failAtFrom) throw new Error('worker stopped');
      if (skipsLeft > 0) {
        skipsLeft--;
        return { usersProcessed: 0, daysComputed: 0, usersSkipped: 1, errors: [], durationMs: 0 };
      }
      const days = o.dayOffsets.to - o.dayOffsets.from;
      return { usersProcessed: 1, daysComputed: days, usersSkipped: 0, errors: [], durationMs: 0 };
    };
    return { calls, rollup };
  }

  it('walks the window in bounded chunks on one anchor and records each one', async () => {
    const { calls, rollup } = rollupRecorder();
    const saved: PortfolioHistoryRollupProgress[] = [];
    const out = await runChunkedRollup(
      'user-1',
      400,
      { anchor, nextDayOffset: 0 },
      {
        rollup,
        saveProgress: async (p) => void saved.push(p),
        onChunk: async () => {},
      }
    );

    expect(out.daysComputed).toBe(400);
    expect(calls.every((c) => c.to - c.from <= PORTFOLIO_HISTORY_CHUNK_DAYS)).toBe(true);
    expect(calls.every((c) => c.runStart === anchor)).toBe(true);
    // Contiguous, no gap and no overlap.
    expect(calls.map((c) => [c.from, c.to])).toEqual(
      Array.from({ length: Math.ceil(400 / PORTFOLIO_HISTORY_CHUNK_DAYS) }, (_, i) => [
        i * PORTFOLIO_HISTORY_CHUNK_DAYS,
        Math.min(400, (i + 1) * PORTFOLIO_HISTORY_CHUNK_DAYS),
      ])
    );
    expect(saved.at(-1)).toEqual({ anchor, nextDayOffset: 400 });
  });

  it('resumes after an interruption at the chunk that did not finish', async () => {
    const stopAt = 3 * PORTFOLIO_HISTORY_CHUNK_DAYS;
    const first = rollupRecorder({ failAtFrom: stopAt });
    let saved: PortfolioHistoryRollupProgress = { anchor, nextDayOffset: 0 };
    const deps = (rollup: typeof first.rollup) => ({
      rollup,
      saveProgress: async (p: PortfolioHistoryRollupProgress) => {
        saved = p;
      },
      onChunk: async () => {},
    });

    await expect(runChunkedRollup('user-1', 400, saved, deps(first.rollup))).rejects.toThrow(
      'worker stopped'
    );
    expect(saved).toEqual({ anchor, nextDayOffset: stopAt });

    const second = rollupRecorder();
    const out = await runChunkedRollup('user-1', 400, saved, deps(second.rollup));
    expect(second.calls[0]?.from).toBe(stopAt);
    expect(second.calls.every((c) => c.runStart === anchor)).toBe(true);
    expect(out.daysComputed).toBe(400 - stopAt);
    expect(saved).toEqual({ anchor, nextDayOffset: 400 });
  });

  it('waits out a lock held between chunks instead of skipping the chunk', async () => {
    const { calls, rollup } = rollupRecorder({ skipTimes: 2 });
    const sleeps: number[] = [];
    const out = await runChunkedRollup(
      'user-1',
      40,
      { anchor, nextDayOffset: 0 },
      {
        rollup,
        saveProgress: async () => {},
        onChunk: async () => {},
        sleep: async (ms) => void sleeps.push(ms),
      }
    );
    expect(out.daysComputed).toBe(40);
    expect(sleeps).toEqual([CHUNK_LOCK_WAIT_MS, CHUNK_LOCK_WAIT_MS]);
    expect(calls[0]).toEqual(calls[2]!);
  });

  it('gives up with the offset named when the lock never frees', async () => {
    const { rollup } = rollupRecorder({ skipTimes: CHUNK_LOCK_MAX_WAITS + 1 });
    await expect(
      runChunkedRollup(
        'user-1',
        40,
        { anchor, nextDayOffset: 0 },
        {
          rollup,
          saveProgress: async () => {},
          onChunk: async () => {},
          sleep: async () => {},
        }
      )
    ).rejects.toThrow('stopped at day offset 0 of 40');
  });
});

describe('resumableProgress (SC-1283)', () => {
  const progress = { anchor: '2026-09-21T01:56:00.000Z', nextDayOffset: 90 };

  it('resumes on the UTC day the window was laid out on', () => {
    expect(resumableProgress(progress, new Date('2026-09-21T23:00:00Z'))).toEqual(progress);
  });

  it('starts over on a later day, so today is not left out', () => {
    expect(resumableProgress(progress, new Date('2026-09-22T00:05:00Z'))).toBeNull();
  });

  it('starts from the top when nothing was recorded', () => {
    expect(resumableProgress(undefined, new Date())).toBeNull();
  });
});
