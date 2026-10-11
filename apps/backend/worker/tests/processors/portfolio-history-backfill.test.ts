import { describe, expect, it, mock } from 'bun:test';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import {
  PORTFOLIO_HISTORY_BACKFILL,
  PORTFOLIO_HISTORY_CHUNK_DAYS,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
  type PortfolioHistoryRollupProgress,
} from '@scani/jobs';
import { type RealTimeEvent, RedisRealtimeUpdatesService } from '@scani/realtime';
import { Container } from 'typedi';
import {
  announceHistoryRebuilt,
  CHUNK_LOCK_MAX_WAITS,
  CHUNK_LOCK_WAIT_MS,
  chunkLockWaitsFor,
  handleMemoryStop,
  handleRollupLockHeld,
  LOCK_HELD_RETRY_DELAY_MS,
  LOCK_HELD_RETRY_REQUEST_ID,
  MEMORY_DEFER_DELAY_MS,
  MEMORY_DEFER_MAX,
  MEMORY_DEFER_REQUEST_PREFIX,
  newerBackfillPending,
  nextMemoryDeferRequestId,
  RollupLockHeld,
  RollupMemoryStop,
  resumableProgress,
  runChunkedRollup,
  scheduleLockHeldRetry,
  scheduleMemoryDeferral,
} from '../../src/processors/portfolio-history-backfill';

restoreContainerAfterAll();

const noJob = async (_jobId: string) => 'unknown';

describe('scheduleLockHeldRetry', () => {
  it('enqueues a delayed backfill with the fixed retry requestId', async () => {
    const add = mock(
      async (_descriptor: unknown, _payload: unknown, _opts?: unknown) => 'job-id-stub'
    );
    await scheduleLockHeldRetry(
      'user-1',
      { add, getJobState: noJob },
      PORTFOLIO_HISTORY_LOOKBACK_DAYS
    );

    expect(add).toHaveBeenCalledTimes(1);
    const [descriptor, payload, opts] = add.mock.calls[0]!;
    expect(descriptor).toBe(PORTFOLIO_HISTORY_BACKFILL);
    expect(payload).toEqual({
      userId: 'user-1',
      requestId: LOCK_HELD_RETRY_REQUEST_ID,
      tokenIds: [],
      lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
      lockHeldDelayMs: LOCK_HELD_RETRY_DELAY_MS,
    });
    expect(opts).toEqual({ delay: LOCK_HELD_RETRY_DELAY_MS });
  });

  it('keeps a wider requested lookback, under its own retry id (SC-1323)', async () => {
    // A 557-day recompute that met the lock was retried at 400 days and
    // collapsed into a pending 400-day retry, so its oldest days never ran.
    const add = mock(
      async (_descriptor: unknown, _payload: unknown, _opts?: unknown) => 'job-id-stub'
    );
    await scheduleLockHeldRetry('user-1', { add, getJobState: noJob }, 557);
    const [, payload] = add.mock.calls[0]!;
    expect(payload).toEqual({
      userId: 'user-1',
      requestId: `${LOCK_HELD_RETRY_REQUEST_ID}-557d`,
      tokenIds: [],
      lookbackDays: 557,
      lockHeldDelayMs: LOCK_HELD_RETRY_DELAY_MS,
    });
  });

  // A 7-day sync that met a running rebuild was retried at 400 days, and that
  // retry held the user's lock for half an hour or more (prod, 2026-10-10).
  it('keeps a narrower requested lookback instead of widening it to the default', async () => {
    const add = mock(
      async (_descriptor: unknown, _payload: unknown, _opts?: unknown) => 'job-id-stub'
    );
    await scheduleLockHeldRetry('user-1', { add, getJobState: noJob }, 7);
    const [, payload] = add.mock.calls[0]!;
    expect(payload).toMatchObject({
      requestId: LOCK_HELD_RETRY_REQUEST_ID,
      lookbackDays: 7,
    });
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

describe('scheduleLockHeldRetry while the lock stays held (SC-1592)', () => {
  type State = 'delayed' | 'active' | 'completed';
  interface Row {
    data: { userId: string; requestId: string; lookbackDays: number };
    state: State;
  }

  // The enqueue path as SC-846 left it: a FINISHED namesake is evicted, and an
  // add onto a live id is dropped by `add_job`'s ON CONFLICT DO NOTHING while
  // the caller is still handed the id. An ACTIVE row is a run whose snapshot
  // may predate the trigger, so landing on one is a lost rebuild.
  function heldLockQueue() {
    const rows = new Map<string, Row>();
    const add = async (descriptor: unknown, payload: unknown, _opts?: unknown) => {
      const data = payload as Row['data'] & { tokenIds: string[] };
      const id = (descriptor as typeof PORTFOLIO_HISTORY_BACKFILL).computeJobId(data);
      if (rows.get(id)?.state === 'completed') rows.delete(id);
      if (!rows.has(id)) rows.set(id, { data, state: 'delayed' });
      return id;
    };
    const getJobState = async (jobId: string) => rows.get(jobId)?.state ?? 'unknown';
    const queue = { add, getJobState };
    const pending = () => [...rows.values()].filter((r) => r.state === 'delayed');
    const takeOne = () => {
      const [row] = pending();
      if (!row) throw new Error('nothing pending to fire');
      row.state = 'active';
      return row;
    };
    // One pending job fires and finds the lock held, as the processor's skip
    // path does: it is ACTIVE while it schedules the next retry.
    const fireOne = async () => {
      const row = takeOne();
      await scheduleLockHeldRetry(row.data.userId, queue, row.data.lookbackDays);
      row.state = 'completed';
    };
    // One pending job fires and TAKES the lock: it stays active, rebuilding.
    const holdOne = () => takeOne();
    const freshSkip = (lookbackDays = PORTFOLIO_HISTORY_LOOKBACK_DAYS) =>
      scheduleLockHeldRetry('user-1', queue, lookbackDays);
    return { queue, pending, fireOne, holdOne, freshSkip };
  }

  for (const lookbackDays of [PORTFOLIO_HISTORY_LOOKBACK_DAYS, 1834]) {
    it(`leaves exactly one pending rebuild across two held retries (${lookbackDays}d)`, async () => {
      const q = heldLockQueue();
      await q.freshSkip(lookbackDays);
      expect(q.pending()).toHaveLength(1);

      await q.fireOne();
      expect(q.pending()).toHaveLength(1);

      await q.fireOne();
      expect(q.pending()).toHaveLength(1);
      expect(q.pending()[0]!.data.lookbackDays).toBe(lookbackDays);
    });
  }

  it('still collapses a flurry of fresh skips into one pending retry', async () => {
    const q = heldLockQueue();
    for (let i = 0; i < 3; i++) await q.freshSkip();
    expect(q.pending()).toHaveLength(1);
  });

  it('a fresh skip behind a retry that HOLDS the lock queues a follow-up after it', async () => {
    const q = heldLockQueue();
    await q.freshSkip();
    const holder = q.holdOne();

    await q.freshSkip();
    await q.freshSkip();

    expect(q.pending()).toHaveLength(1);
    expect(q.pending()[0]!.data.requestId).not.toBe(holder.data.requestId);
  });

  it('a retry that skips while another slot holds the lock still leaves one pending', async () => {
    const q = heldLockQueue();
    await q.freshSkip();
    q.holdOne();
    await q.freshSkip();

    await q.fireOne();
    expect(q.pending()).toHaveLength(1);
  });

  it('never drops the rebuild when every slot is running', async () => {
    const q = heldLockQueue();
    for (let i = 0; i < 3; i++) {
      await q.freshSkip();
      q.holdOne();
    }
    await q.freshSkip();
    expect(q.pending()).toHaveLength(1);
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
        return {
          usersProcessed: 0,
          daysComputed: 0,
          usersSkipped: 1,
          errors: [],
          durationMs: 0,
          rolledUpUserIds: [] as string[],
        };
      }
      const days = o.dayOffsets.to - o.dayOffsets.from;
      return {
        usersProcessed: 1,
        daysComputed: days,
        usersSkipped: 0,
        errors: [],
        durationMs: 0,
        rolledUpUserIds: ['user-1'],
      };
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

  it('stops before a chunk when memory is short, with progress at that chunk', async () => {
    const { calls, rollup } = rollupRecorder();
    let saved: PortfolioHistoryRollupProgress = { anchor, nextDayOffset: 0 };
    const stopAt = 2 * PORTFOLIO_HISTORY_CHUNK_DAYS;
    const run = runChunkedRollup('user-1', 400, saved, {
      rollup,
      saveProgress: async (p) => {
        saved = p;
      },
      onChunk: async () => {},
      memoryStopReason: () => (calls.length === 2 ? 'worker RSS 600 MB is over' : null),
    });
    await expect(run).rejects.toBeInstanceOf(RollupMemoryStop);
    await expect(run).rejects.toThrow(`before day offset ${stopAt} of 400`);
    // The chunk that did not fit was never started, and the next attempt
    // starts at it.
    expect(calls.map((c) => c.from)).toEqual([0, PORTFOLIO_HISTORY_CHUNK_DAYS]);
    expect(saved).toEqual({ anchor, nextDayOffset: stopAt });
  });

  it('checks memory before every chunk, the first included', async () => {
    const { rollup } = rollupRecorder();
    let checks = 0;
    await runChunkedRollup(
      'user-1',
      100,
      { anchor, nextDayOffset: 0 },
      {
        rollup,
        saveProgress: async () => {},
        onChunk: async () => {},
        memoryStopReason: () => {
          checks++;
          return null;
        },
      }
    );
    expect(checks).toBe(Math.ceil(100 / PORTFOLIO_HISTORY_CHUNK_DAYS));
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

  // SC-1595: a holder longer than the wait budget is a delay, not an error.
  it('stops as a typed lock-held stop at the offset it could not run', async () => {
    const { rollup } = rollupRecorder({ skipTimes: CHUNK_LOCK_MAX_WAITS + 1 });
    const stopped = await runChunkedRollup(
      'user-1',
      40,
      { anchor, nextDayOffset: 0 },
      { rollup, saveProgress: async () => {}, onChunk: async () => {}, sleep: async () => {} }
    ).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(RollupLockHeld);
    expect((stopped as RollupLockHeld).nextDayOffset).toBe(0);
  });

  it('a retry with no waits defers at once, with no sleep', async () => {
    const { rollup } = rollupRecorder({ skipTimes: 1 });
    const sleeps: number[] = [];
    const stopped = await runChunkedRollup(
      'user-1',
      40,
      { anchor, nextDayOffset: 0 },
      {
        rollup,
        saveProgress: async () => {},
        onChunk: async () => {},
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        maxLockWaits: 0,
      }
    ).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(RollupLockHeld);
    expect(sleeps).toEqual([]);
  });

  it('CONTROL: a rollup that throws still fails with its own error', async () => {
    const boom = new Error('rollup exploded');
    await expect(
      runChunkedRollup(
        'user-1',
        40,
        { anchor, nextDayOffset: 0 },
        {
          rollup: async () => {
            throw boom;
          },
          saveProgress: async () => {},
          onChunk: async () => {},
          sleep: async () => {},
        }
      )
    ).rejects.toBe(boom);
  });
});

// Feeds' review of #2268: a lock-held retry must not wait on the lock again
// (20 x 15s holding a worker slot per cycle), and its re-arm backs off.
describe('a lock-held retry defers without waiting (SC-1595)', () => {
  it('a lock-held retry gets no chunk lock waits; a fresh backfill keeps the budget', () => {
    expect(chunkLockWaitsFor(LOCK_HELD_RETRY_REQUEST_ID)).toBe(0);
    expect(chunkLockWaitsFor(`${LOCK_HELD_RETRY_REQUEST_ID}-1834d-2`)).toBe(0);
    expect(chunkLockWaitsFor('tx-import-5970683-400d')).toBe(CHUNK_LOCK_MAX_WAITS);
  });

  it('the re-arm delay doubles per held retry, capped at 15 minutes', async () => {
    const delays: number[] = [];
    const carried: unknown[] = [];
    const queue = {
      add: async (_d: unknown, payload: unknown, opts?: unknown) => {
        carried.push((payload as { lockHeldDelayMs?: number }).lockHeldDelayMs);
        delays.push((opts as { delay: number }).delay);
        return 'job-id-stub';
      },
      getJobState: async (_id: string) => 'unknown',
    };
    await scheduleLockHeldRetry('user-1', queue, 400);
    await scheduleLockHeldRetry('user-1', queue, 400, LOCK_HELD_RETRY_DELAY_MS);
    await scheduleLockHeldRetry('user-1', queue, 400, 12 * 60_000);
    expect(delays).toEqual([LOCK_HELD_RETRY_DELAY_MS, 2 * LOCK_HELD_RETRY_DELAY_MS, 15 * 60_000]);
    expect(carried).toEqual(delays);
  });
});

describe('handleRollupLockHeld (SC-1595)', () => {
  it('queues one rebuild behind the holder instead of failing', async () => {
    const added: Array<{ requestId: string; lookbackDays: number; delay?: number }> = [];
    const queue = {
      add: async (_d: unknown, payload: unknown, opts?: unknown) => {
        const p = payload as { requestId: string; lookbackDays: number };
        added.push({ ...p, delay: (opts as { delay?: number } | undefined)?.delay });
        return 'job-id-stub';
      },
      getJobState: async (_id: string) => 'unknown',
    };
    const stop = new RollupLockHeld('Rollup lock stayed held', 21);
    const out = await handleRollupLockHeld(
      { userId: 'user-1', requestId: 'tx-import-1-400d', tokenIds: [], lookbackDays: 400 },
      stop,
      queue
    );
    expect(out).toEqual({ deferredAtDayOffset: 21 });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ lookbackDays: 400, delay: LOCK_HELD_RETRY_DELAY_MS });
    expect(added[0]!.requestId.startsWith(LOCK_HELD_RETRY_REQUEST_ID)).toBe(true);
  });
});

// SC-1513: one user's 1,861-day backfill kept a shared-cpu worker over its CPU
// baseline for three hours, and the throttle doubled every scheduled job.
describe('runChunkedRollup pacing (SC-1513)', () => {
  const anchor = '2026-10-03T10:07:44.840Z';
  const CHUNK_MS = 10_000;

  function clockedRollup() {
    let clock = 0;
    const rollup = async (o: { dayOffsets: { from: number; to: number } }) => {
      clock += CHUNK_MS;
      const days = o.dayOffsets.to - o.dayOffsets.from;
      return {
        usersProcessed: 1,
        daysComputed: days,
        usersSkipped: 0,
        errors: [],
        durationMs: 0,
        rolledUpUserIds: ['user-1'],
      };
    };
    return { rollup, now: () => clock };
  }

  it('rests between chunks for the pace factor times the chunk it just ran, and not after the last', async () => {
    const { rollup, now } = clockedRollup();
    const sleeps: number[] = [];
    await runChunkedRollup(
      'user-1',
      3 * PORTFOLIO_HISTORY_CHUNK_DAYS,
      { anchor, nextDayOffset: 0 },
      {
        rollup,
        saveProgress: async () => {},
        onChunk: async () => {},
        sleep: async (ms) => void sleeps.push(ms),
        now,
        pace: { factor: 2, newerRequestPending: async () => false },
      }
    );
    expect(sleeps).toEqual([2 * CHUNK_MS, 2 * CHUNK_MS]);
  });

  it('stops resting once a newer request for the user is waiting, so it is not held behind the pace', async () => {
    const { rollup, now } = clockedRollup();
    const sleeps: number[] = [];
    let asked = 0;
    await runChunkedRollup(
      'user-1',
      4 * PORTFOLIO_HISTORY_CHUNK_DAYS,
      { anchor, nextDayOffset: 0 },
      {
        rollup,
        saveProgress: async () => {},
        onChunk: async () => {},
        sleep: async (ms) => void sleeps.push(ms),
        now,
        pace: { factor: 2, newerRequestPending: async () => ++asked > 1 },
      }
    );
    expect(sleeps).toEqual([2 * CHUNK_MS]);
  });

  it('does not rest at all without a pace', async () => {
    const { rollup, now } = clockedRollup();
    const sleeps: number[] = [];
    await runChunkedRollup(
      'user-1',
      3 * PORTFOLIO_HISTORY_CHUNK_DAYS,
      { anchor, nextDayOffset: 0 },
      {
        rollup,
        saveProgress: async () => {},
        onChunk: async () => {},
        sleep: async (ms) => void sleeps.push(ms),
        now,
      }
    );
    expect(sleeps).toEqual([]);
  });
});

describe('newerBackfillPending (SC-1513)', () => {
  const name = PORTFOLIO_HISTORY_BACKFILL.name;
  const queue = (jobs: Array<{ id: string; name: string; data: unknown }>) => ({
    getJobs: async (types: Array<'waiting' | 'delayed'>) => {
      expect(types).toEqual(['waiting', 'delayed']);
      return jobs;
    },
  });

  it('finds a newer backfill for the same user', async () => {
    const q = queue([{ id: 'retry', name, data: { userId: 'u1' } }]);
    expect(await newerBackfillPending(q, 'u1', 'own')).toBe(true);
  });

  it('ignores the running job itself, other users and other jobs', async () => {
    const q = queue([
      { id: 'own', name, data: { userId: 'u1' } },
      { id: 'other-user', name, data: { userId: 'u2' } },
      { id: 'other-job', name: 'wallet-balances', data: { userId: 'u1' } },
    ]);
    expect(await newerBackfillPending(q, 'u1', 'own')).toBe(false);
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

describe('memory deferral (SC-1298)', () => {
  it('hands the next attempt a distinct requestId so it cannot dedup away', () => {
    const first = nextMemoryDeferRequestId('mutation-1');
    expect(first).toBe(`${MEMORY_DEFER_REQUEST_PREFIX}1`);
    expect(nextMemoryDeferRequestId(first!)).toBe(`${MEMORY_DEFER_REQUEST_PREFIX}2`);
  });

  it('gives up after a bounded number of deferrals rather than looping', () => {
    let id: string | null = 'mutation-1';
    const seen: string[] = [];
    for (let i = 0; i < MEMORY_DEFER_MAX + 2 && id !== null; i++) {
      id = nextMemoryDeferRequestId(id);
      if (id) seen.push(id);
    }
    expect(seen).toHaveLength(MEMORY_DEFER_MAX);
    expect(id).toBeNull();
  });

  it('carries the saved progress forward, so the continuation resumes mid-window', async () => {
    const add = mock(async (_d: unknown, _p: unknown, _o?: unknown) => 'job-id-stub');
    const progress = { anchor: '2026-09-23T01:00:00.000Z', nextDayOffset: 300 };
    const scheduled = await scheduleMemoryDeferral(
      { userId: 'user-1', requestId: 'tx-import-1', tokenIds: [], lookbackDays: 400 },
      progress,
      { add }
    );

    expect(scheduled).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    const [descriptor, payload, opts] = add.mock.calls[0]!;
    expect(descriptor).toBe(PORTFOLIO_HISTORY_BACKFILL);
    expect(payload).toEqual({
      userId: 'user-1',
      requestId: `${MEMORY_DEFER_REQUEST_PREFIX}1`,
      tokenIds: [],
      lookbackDays: 400,
      rollupProgress: progress,
    });
    expect(opts).toEqual({ delay: MEMORY_DEFER_DELAY_MS });
  });

  it('refuses to schedule past the bound, so an unrecoverable box reports loudly', async () => {
    const add = mock(async (_d: unknown, _p: unknown, _o?: unknown) => 'job-id-stub');
    const scheduled = await scheduleMemoryDeferral(
      {
        userId: 'user-1',
        requestId: `${MEMORY_DEFER_REQUEST_PREFIX}${MEMORY_DEFER_MAX}`,
        tokenIds: [],
        lookbackDays: 400,
      },
      { anchor: '2026-09-23T01:00:00.000Z', nextDayOffset: 300 },
      { add }
    );

    expect(scheduled).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it('names the offset on the error, so the continuation is not parsed out of a message', async () => {
    const rollup = async (o: { dayOffsets: { from: number; to: number } }) => ({
      usersProcessed: 1,
      daysComputed: o.dayOffsets.to - o.dayOffsets.from,
      usersSkipped: 0,
      errors: [],
      durationMs: 0,
      rolledUpUserIds: ['user-1'],
    });
    const stopAt = 2 * PORTFOLIO_HISTORY_CHUNK_DAYS;
    const run = runChunkedRollup(
      'user-1',
      400,
      { anchor: '2026-09-23T01:00:00.000Z', nextDayOffset: 0 },
      {
        rollup,
        saveProgress: async () => {},
        onChunk: async () => {},
        memoryStopReason: (from) => (from === stopAt ? 'worker RSS 653 MB is over' : null),
      }
    );
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RollupMemoryStop);
    expect((err as RollupMemoryStop).nextDayOffset).toBe(stopAt);
  });
});

describe('handleMemoryStop (SC-1298)', () => {
  const stop = () => new RollupMemoryStop('worker RSS 653 MB is over the budget', 300);

  it('defers the rest of the window and reports where it stopped', async () => {
    const add = mock(async (_d: unknown, _p: unknown, _o?: unknown) => 'job-id-stub');
    const out = await handleMemoryStop(
      { userId: 'user-1', requestId: 'tx-import-1', tokenIds: [], lookbackDays: 400 },
      '2026-09-23T01:00:00.000Z',
      stop(),
      { add }
    );

    expect(out).toEqual({ deferredAtDayOffset: 300 });
    expect(add.mock.calls[0]![1]).toMatchObject({
      rollupProgress: { anchor: '2026-09-23T01:00:00.000Z', nextDayOffset: 300 },
    });
  });

  // The bound spent is the one case that IS a Sentry-worthy failure: the box,
  // not this chunk, cannot finish the window.
  it('rethrows the stop once the chain is spent, so it reaches Sentry', async () => {
    const add = mock(async (_d: unknown, _p: unknown, _o?: unknown) => 'job-id-stub');
    const thrown = stop();
    await expect(
      handleMemoryStop(
        {
          userId: 'user-1',
          requestId: `${MEMORY_DEFER_REQUEST_PREFIX}${MEMORY_DEFER_MAX}`,
          tokenIds: [],
          lookbackDays: 400,
        },
        '2026-09-23T01:00:00.000Z',
        thrown,
        { add }
      )
    ).rejects.toBe(thrown);
    expect(add).not.toHaveBeenCalled();
  });
});

describe('announceHistoryRebuilt (SC-1600)', () => {
  it('tells the open app its chart changed, and nothing about holdings', () => {
    const events: Array<Omit<RealTimeEvent, 'timestamp'>> = [];
    Container.set(RedisRealtimeUpdatesService, {
      broadcast: (event: Omit<RealTimeEvent, 'timestamp'>) => {
        events.push(event);
      },
    } as unknown as RedisRealtimeUpdatesService);
    announceHistoryRebuilt('user-1', null);
    expect(
      events.map(({ entityType, operationType, userId }) => ({ entityType, operationType, userId }))
    ).toEqual([{ entityType: 'portfolio', operationType: 'sync', userId: 'user-1' }]);
  });

  it('says nothing while a continuation is queued: the chain is not finished (feeds, #22607)', () => {
    const events: Array<Omit<RealTimeEvent, 'timestamp'>> = [];
    Container.set(RedisRealtimeUpdatesService, {
      broadcast: (event: Omit<RealTimeEvent, 'timestamp'>) => {
        events.push(event);
      },
    } as unknown as RedisRealtimeUpdatesService);
    announceHistoryRebuilt('user-1', 180);
    expect(events).toEqual([]);
  });
});

// SC-1607: a rebuild carries the day its trigger starts at. Whatever joins it
// later must keep the EARLIEST of the starts it absorbed, or one edit's range
// is quietly rebuilt from too late a day (feeds, #22795).
describe('the start day survives retries and continuations (SC-1607)', () => {
  type Data = {
    userId: string;
    requestId: string;
    tokenIds: string[];
    lookbackDays: number;
    fromDay?: string;
  };

  function pendingQueue() {
    const rows = new Map<string, { data: Data; state: 'delayed' | 'active' }>();
    const queue = {
      add: async (descriptor: unknown, payload: unknown, _opts?: unknown) => {
        const data = payload as Data;
        const id = (descriptor as typeof PORTFOLIO_HISTORY_BACKFILL).computeJobId(data);
        if (!rows.has(id)) rows.set(id, { data, state: 'delayed' });
        return id;
      },
      getJobState: async (jobId: string) => rows.get(jobId)?.state ?? 'unknown',
      getJobData: async (jobId: string) => rows.get(jobId)?.data,
      updateJobData: async (jobId: string, data: unknown) => {
        const row = rows.get(jobId);
        if (row) row.data = data as Data;
      },
    };
    const pending = () => [...rows.values()].filter((r) => r.state === 'delayed');
    return { queue, pending };
  }

  it('a fresh retry carries the start day', async () => {
    const q = pendingQueue();
    await scheduleLockHeldRetry('user-1', q.queue, 400, undefined, '2026-10-01');
    expect(q.pending()[0]!.data.fromDay).toBe('2026-10-01');
  });

  it('a pending retry absorbs an earlier start', async () => {
    const q = pendingQueue();
    await scheduleLockHeldRetry('user-1', q.queue, 400, undefined, '2026-10-01');
    await scheduleLockHeldRetry('user-1', q.queue, 400, undefined, '2026-09-12');
    expect(q.pending()).toHaveLength(1);
    expect(q.pending()[0]!.data.fromDay).toBe('2026-09-12');
  });

  it('control: a later start leaves the pending retry where it was', async () => {
    const q = pendingQueue();
    await scheduleLockHeldRetry('user-1', q.queue, 400, undefined, '2026-09-12');
    await scheduleLockHeldRetry('user-1', q.queue, 400, undefined, '2026-10-01');
    expect(q.pending()).toHaveLength(1);
    expect(q.pending()[0]!.data.fromDay).toBe('2026-09-12');
  });

  it('a pending narrow retry absorbs a wider request, so its oldest days still run', async () => {
    const q = pendingQueue();
    await scheduleLockHeldRetry('user-1', q.queue, 7);
    await scheduleLockHeldRetry('user-1', q.queue, 400);
    expect(q.pending()).toHaveLength(1);
    expect(q.pending()[0]!.data.lookbackDays).toBe(400);
  });

  it('control: a narrower request leaves a pending wider retry as wide as it was', async () => {
    const q = pendingQueue();
    await scheduleLockHeldRetry('user-1', q.queue, 400);
    await scheduleLockHeldRetry('user-1', q.queue, 7);
    expect(q.pending()).toHaveLength(1);
    expect(q.pending()[0]!.data.lookbackDays).toBe(400);
  });

  it('a whole-window request makes the pending retry whole', async () => {
    const q = pendingQueue();
    await scheduleLockHeldRetry('user-1', q.queue, 400, undefined, '2026-10-01');
    await scheduleLockHeldRetry('user-1', q.queue, 400);
    expect(q.pending()).toHaveLength(1);
    expect(q.pending()[0]!.data.fromDay).toBeUndefined();
  });

  it('a chunk that meets a held lock queues its rebuild from the same start day', async () => {
    const q = pendingQueue();
    await handleRollupLockHeld(
      {
        userId: 'user-1',
        requestId: 'mutation-1-400',
        tokenIds: [],
        lookbackDays: 400,
        fromDay: '2026-09-30',
      },
      new RollupLockHeld('held', 30),
      q.queue
    );
    expect(q.pending()[0]!.data.fromDay).toBe('2026-09-30');
  });

  it('a memory-deferred continuation carries the start day', async () => {
    const add = mock(async (_d: unknown, _p: unknown, _o?: unknown) => 'job-id-stub');
    await scheduleMemoryDeferral(
      {
        userId: 'user-1',
        requestId: 'mutation-1-400',
        tokenIds: [],
        lookbackDays: 400,
        fromDay: '2026-09-30',
      },
      { anchor: '2026-10-07T01:00:00.000Z', nextDayOffset: 30 },
      { add }
    );
    expect((add.mock.calls[0]![1] as Data).fromDay).toBe('2026-09-30');
  });
});
