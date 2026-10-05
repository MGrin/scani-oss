import { OpeningBalanceReconciliationService, PriceHubResolver } from '@scani/domain/services';
import type { RollupSummary } from '@scani/domain/use-cases';
import {
  BackfillHistoricalPricesUseCase,
  LinkTransferPairsUseCase,
  RollupPortfolioValueDailyUseCase,
} from '@scani/domain/use-cases';
import {
  PORTFOLIO_HISTORY_BACKFILL,
  PORTFOLIO_HISTORY_CHUNK_DAYS,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
  type PortfolioHistoryBackfillJob,
  type PortfolioHistoryRollupProgress,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import {
  BullMqEnqueueService,
  type ProcessorContext,
  QueueClient,
  UserJobProcessor,
} from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { Container, Service } from 'typedi';
import { withJobLock } from '../lib/cron-lock';
import { memoryStopReason, readMemory } from '../lib/memory-budget';

// When the per-user advisory lock is held by an in-flight backfill, a
// freshly-enqueued one would silently skip — leaving any data inserted
// AFTER the in-flight backfill's snapshot was taken (e.g., wallet add
// followed by integration add) un-rolled until the next nightly cron.
// Re-enqueuing with a fixed `lock-held-retry` requestId means at most
// one pending retry per user (BullMQ jobId dedup), so a flurry of
// skipped runs collapses into a single delayed tick.
export const LOCK_HELD_RETRY_REQUEST_ID = 'lock-held-retry';
export const LOCK_HELD_RETRY_DELAY_MS = 90_000;

export const MEMORY_DEFER_REQUEST_PREFIX = 'memory-deferred-';
// Long enough for a restart to have happened, short enough that the whole
// chain still lands inside the UTC day `resumableProgress` requires — a
// deferral past midnight discards the progress and re-runs from day 0.
export const MEMORY_DEFER_DELAY_MS = 300_000;
// Bounded, because RSS on a JSC heap does not fall while the process lives: an
// unbounded chain would defer quietly forever on a box that cannot finish.
// Past the bound the stop throws and Sentry gets an error that is now a claim
// about the BOX rather than about one chunk.
export const MEMORY_DEFER_MAX = 6;

// The continuation's requestId, or null at the bound. It is part of the jobId
// (`computeJobId`), so each link must be DISTINCT: a fixed id would dedup
// against the retained completed job that scheduled it — `removeOnComplete:
// 100` keeps it around — and the chain would end with nothing reporting it.
export function nextMemoryDeferRequestId(requestId: string): string | null {
  const n = requestId.startsWith(MEMORY_DEFER_REQUEST_PREFIX)
    ? Number(requestId.slice(MEMORY_DEFER_REQUEST_PREFIX.length))
    : 0;
  if (!Number.isInteger(n) || n < 0 || n >= MEMORY_DEFER_MAX) return null;
  return `${MEMORY_DEFER_REQUEST_PREFIX}${n + 1}`;
}

interface EnqueueServiceLike {
  add: (typeof BullMqEnqueueService)['prototype']['add'];
}

// Enqueue the continuation of a memory-stopped run. False means the bound is
// spent and the caller must let the stop surface.
export async function scheduleMemoryDeferral(
  data: PortfolioHistoryBackfillJob,
  progress: PortfolioHistoryRollupProgress,
  enqueueService: EnqueueServiceLike
): Promise<boolean> {
  const requestId = nextMemoryDeferRequestId(data.requestId);
  if (requestId === null) return false;
  await enqueueService.add(
    PORTFOLIO_HISTORY_BACKFILL,
    {
      userId: data.userId,
      requestId,
      tokenIds: data.tokenIds,
      lookbackDays: data.lookbackDays,
      rollupProgress: progress,
    },
    { delay: MEMORY_DEFER_DELAY_MS }
  );
  return true;
}

// A memory stop, resolved: either the rest of the window is queued to continue
// or the chain is spent and the stop surfaces unchanged. Separate from the
// processor method so the branch is testable without the container.
export async function handleMemoryStop(
  data: PortfolioHistoryBackfillJob,
  anchor: string,
  stop: RollupMemoryStop,
  enqueueService: EnqueueServiceLike
): Promise<{ deferredAtDayOffset: number }> {
  const progress: PortfolioHistoryRollupProgress = {
    anchor,
    nextDayOffset: stop.nextDayOffset,
  };
  if (!(await scheduleMemoryDeferral(data, progress, enqueueService))) throw stop;
  return { deferredAtDayOffset: stop.nextDayOffset };
}

export async function scheduleLockHeldRetry(
  userId: string,
  enqueueService: EnqueueServiceLike,
  requestedLookbackDays: number = PORTFOLIO_HISTORY_LOOKBACK_DAYS
): Promise<void> {
  // A wider request keeps its width and gets its own retry id: under the
  // shared id it would collapse into a pending default-width retry and its
  // oldest days would never run (SC-1323).
  const lookbackDays = Math.max(requestedLookbackDays, PORTFOLIO_HISTORY_LOOKBACK_DAYS);
  const requestId =
    lookbackDays > PORTFOLIO_HISTORY_LOOKBACK_DAYS
      ? `${LOCK_HELD_RETRY_REQUEST_ID}-${lookbackDays}d`
      : LOCK_HELD_RETRY_REQUEST_ID;
  await enqueueService.add(
    PORTFOLIO_HISTORY_BACKFILL,
    {
      userId,
      requestId,
      // Empty tokenIds + at least the full lookback so the retry catches
      // everything the original triggers were meant to cover, regardless of
      // who first hit the lock.
      tokenIds: [],
      lookbackDays,
    },
    { delay: LOCK_HELD_RETRY_DELAY_MS }
  );
}

const logger = createComponentLogger('processor:portfolio-history-backfill');

// A resumed attempt reports zeros for the phases a previous attempt finished.
const SKIPPED_RECONCILIATION = { holdingsTouched: 0, openingsSynthesized: 0 };
const SKIPPED_PRICES = {
  attempted: 0,
  inserted: 0,
  alreadyHad: 0,
  providerMissing: 0,
  droppedDays: 0,
};

// A saved position is only worth resuming on the UTC day it was laid out on.
// A retry pressed the next day would otherwise skip today's row entirely, and
// re-running from day 0 costs one full pass — the thing this job does anyway.
export function resumableProgress(
  progress: PortfolioHistoryRollupProgress | undefined,
  now: Date
): PortfolioHistoryRollupProgress | null {
  if (!progress) return null;
  if (progress.anchor.slice(0, 10) !== now.toISOString().slice(0, 10)) return null;
  return progress;
}

// The nightly rollup and price-backfill crons take the same per-user lock the
// rollup does, and a chunked run releases it between chunks. A chunk that
// finds it held did not run, so it waits for the holder rather than spending
// one of the job's two attempts.
export const CHUNK_LOCK_WAIT_MS = 15_000;
export const CHUNK_LOCK_MAX_WAITS = 20;

export interface ChunkedRollupDeps {
  rollup: (opts: {
    userId: string;
    lookbackDays: number;
    runStart: Date;
    dayOffsets: { from: number; to: number };
  }) => Promise<RollupSummary>;
  saveProgress: (progress: PortfolioHistoryRollupProgress) => Promise<void>;
  onChunk: (daysDone: number, lookbackDays: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Why the next chunk must not start, or null to go ahead. Asked before
  // every chunk, the first included.
  memoryStopReason?: (fromDayOffset: number) => string | null;
  pace?: ChunkPace;
}

// A rest of `factor` times each chunk's own duration before the next (SC-1513).
// One 1,861-day backfill held a shared-cpu worker over its CPU baseline for
// three hours, and Fly's throttle doubled every scheduled job on the box. A
// rest skipped while a newer request for the user waits keeps that request from
// queueing behind the pace: it only ever waits as long as it did unpaced.
interface ChunkPace {
  factor: number;
  newerRequestPending: () => Promise<boolean>;
}

const BACKFILL_PACE_FACTOR = 2;

// Any other backfill for this user waiting or delayed: a fresh mutation's job,
// or the lock-held retry one schedules when it finds this run holding the lock.
export async function newerBackfillPending(
  queue: {
    getJobs(
      types: Array<'waiting' | 'delayed'>
    ): Promise<Array<{ id?: string; name: string; data: unknown }>>;
  },
  userId: string,
  ownJobId: string | undefined
): Promise<boolean> {
  const jobs = await queue.getJobs(['waiting', 'delayed']);
  return jobs.some(
    (job) =>
      job.name === PORTFOLIO_HISTORY_BACKFILL.name &&
      job.id !== ownJobId &&
      (job.data as { userId?: string } | undefined)?.userId === userId
  );
}

// Thrown between chunks when the worker is too close to the VM's limit to
// start another. Stopping here is the point: on 2026-09-21 the alternative was
// the box at 0 MB and the watchdog unable to act for four minutes (SC-1283).
//
// This used to escape the processor, and the sentence that stood here — that
// "the job's retry, or a Retry pressed the same day, starts there" — was the
// defect (SC-1298). BullMQ's retry is 30 seconds later IN THE SAME PROCESS, and
// the number that stopped it is the whole worker's RSS after a full GC; it does
// not move in 30 seconds. So the retry stopped at the same offset and the job
// dead-lettered. `handleMemoryStop` catches it now.
export class RollupMemoryStop extends Error {
  override readonly name = 'RollupMemoryStop';
  // Carried rather than parsed back out of `message`: the continuation resumes
  // here, and a resume point recovered from prose is one rewording from wrong.
  constructor(
    message: string,
    readonly nextDayOffset: number
  ) {
    super(message);
  }
}

// Walk the lookback window PORTFOLIO_HISTORY_CHUNK_DAYS at a time (SC-1283).
// Each chunk is its own rollup call, so everything it prefetched and every
// per-day result it built is unreachable before the next one starts; memory
// stays at one chunk's worth however long the window is. Progress is saved
// after each chunk, so an attempt stopped mid-window resumes at the next one.
export async function runChunkedRollup(
  userId: string,
  lookbackDays: number,
  start: PortfolioHistoryRollupProgress,
  deps: ChunkedRollupDeps
): Promise<{ usersProcessed: number; daysComputed: number; errors: RollupSummary['errors'] }> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? Date.now;
  const runStart = new Date(start.anchor);
  const out = { usersProcessed: 0, daysComputed: 0, errors: [] as RollupSummary['errors'] };
  let from = start.nextDayOffset;
  while (from < lookbackDays) {
    const to = Math.min(lookbackDays, from + PORTFOLIO_HISTORY_CHUNK_DAYS);
    const stop = deps.memoryStopReason?.(from);
    if (stop) {
      throw new RollupMemoryStop(
        `${stop}; stopped before day offset ${from} of ${lookbackDays}, progress saved`,
        from
      );
    }
    let chunkStart = now();
    let summary = await deps.rollup({ userId, lookbackDays, runStart, dayOffsets: { from, to } });
    for (let waits = 0; summary.usersSkipped > 0; waits++) {
      if (waits >= CHUNK_LOCK_MAX_WAITS) {
        throw new Error(
          `Rollup lock for ${userId} stayed held; stopped at day offset ${from} of ${lookbackDays}`
        );
      }
      await sleep(CHUNK_LOCK_WAIT_MS);
      chunkStart = now();
      summary = await deps.rollup({ userId, lookbackDays, runStart, dayOffsets: { from, to } });
    }
    out.usersProcessed = Math.max(out.usersProcessed, summary.usersProcessed);
    out.daysComputed += summary.daysComputed;
    out.errors.push(...summary.errors);
    await deps.saveProgress({ anchor: start.anchor, nextDayOffset: to });
    await deps.onChunk(to, lookbackDays);
    const chunkMs = now() - chunkStart;
    from = to;
    if (deps.pace && from < lookbackDays && !(await deps.pace.newerRequestPending())) {
      await sleep(Math.round(chunkMs * deps.pace.factor));
    }
  }
  return out;
}

interface PortfolioHistoryBackfillResult {
  tokenCount: number;
  lookbackDays: number;
  reconciliation: { holdingsTouched: number; openingsSynthesized: number };
  prices: {
    attempted: number;
    inserted: number;
    alreadyHad: number;
    providerMissing: number;
    // Attempted days a provider answered only with bars the writer does not store.
    droppedDays: number;
  };
  rollup: { usersProcessed: number; daysComputed: number; errorCount: number };
  // The day offset a memory stop deferred the rest of the window at, or null
  // where the window finished. A deferred run is a SUCCESS with work queued,
  // not a partial failure — the /jobs UI and the job result both have to be
  // able to say which (SC-1298).
  deferredAtDayOffset: number | null;
}

@Service()
export class PortfolioHistoryBackfillProcessor extends UserJobProcessor<
  PortfolioHistoryBackfillJob,
  PortfolioHistoryBackfillResult
> {
  readonly descriptor = PORTFOLIO_HISTORY_BACKFILL;

  protected async handle(
    data: PortfolioHistoryBackfillJob,
    ctx: ProcessorContext
  ): Promise<PortfolioHistoryBackfillResult> {
    // Per-user advisory lock. Backfill is heavy (22k+ token-day tuples per
    // run) and idempotent — the holdings router enqueues one per
    // mutation, so a user clicking around can stack 4+ jobs that each
    // pin a worker concurrency slot for several minutes, blocking all
    // other user-initiated jobs from running. Locking by `userId` lets
    // the first runner do the work; the rest no-op in milliseconds.
    const lockKey = `portfolio-history-backfill:${data.userId}`;
    const outcome = await withJobLock(lockKey, () => this.runBackfill(data, ctx));
    if (outcome.ran) return outcome.result;

    // Lock held by another in-flight backfill. The in-flight run took its
    // holdings/transactions snapshot before our trigger landed, so any
    // data the current job was supposed to roll up may be missing. Queue
    // a delayed retry (fixed requestId → at most one pending per user)
    // so the work is picked up the moment the lock clears.
    try {
      await scheduleLockHeldRetry(
        data.userId,
        Container.get(BullMqEnqueueService),
        data.lookbackDays
      );
      logger.info(
        {
          jobId: ctx.job.id,
          userId: data.userId,
          retryDelayMs: LOCK_HELD_RETRY_DELAY_MS,
          skipIsRetry: data.requestId.startsWith(LOCK_HELD_RETRY_REQUEST_ID),
        },
        'Backfill skipped (lock held) — delayed retry enqueued'
      );
    } catch (err) {
      logger.warn(
        {
          jobId: ctx.job.id,
          userId: data.userId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Backfill skipped (lock held) — failed to enqueue delayed retry'
      );
    }
    return {
      tokenCount: data.tokenIds.length,
      lookbackDays: data.lookbackDays,
      reconciliation: SKIPPED_RECONCILIATION,
      prices: SKIPPED_PRICES,
      rollup: { usersProcessed: 0, daysComputed: 0, errorCount: 0 },
      deferredAtDayOffset: null,
    };
  }

  private async runBackfill(
    data: PortfolioHistoryBackfillJob,
    ctx: ProcessorContext
  ): Promise<PortfolioHistoryBackfillResult> {
    const resume = resumableProgress(data.rollupProgress, new Date());
    if (resume) {
      logger.info(
        { jobId: ctx.job.id, userId: data.userId, ...resume },
        'Resuming portfolio history rollup where the last attempt stopped'
      );
      return this.rollupPhase(data, ctx, resume, SKIPPED_RECONCILIATION, SKIPPED_PRICES);
    }

    // The base every backfilled price is stored against.
    const usdTokenId = await Container.get(PriceHubResolver).usdTokenId();
    await ctx.reportProgress(0.05);

    // Re-reconcile every holding's opening balance BEFORE pricing/rollup.
    // The reconciler is now self-aware (excludes its own past output
    // from the sum), so this pass cleans up any stale synthesized
    // opening rows left behind by token-merge migrations or by an
    // import that landed mid-flight. Without this, cost basis stays
    // anchored to the bogus opening and PnL stays wrong even after a
    // fresh price backfill.
    const reconcileSummary = await this.reconcileUser(data.userId);
    await ctx.reportProgress(0.15);

    // Link cross-account transfer pairs before the rollup — its
    // cost-basis walk reads `transfer_group_id` to carry lot cost across
    // a transfer instead of resetting it to market value. Cheap (two
    // queries + in-memory matching); a failure is non-fatal — the rollup
    // still runs, just without fresh linkage.
    try {
      await Container.get(LinkTransferPairsUseCase).execute({ userId: data.userId });
    } catch (error) {
      logger.warn(
        { userId: data.userId, error: error instanceof Error ? error.message : error },
        'Transfer linking failed during backfill; continuing'
      );
    }
    await ctx.reportProgress(0.2);

    const priceSummary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      usdTokenId,
      userId: data.userId,
      tokenIds: data.tokenIds,
      lookbackDays: data.lookbackDays,
    });
    await ctx.reportProgress(0.55);

    const progress: PortfolioHistoryRollupProgress = {
      anchor: new Date().toISOString(),
      nextDayOffset: 0,
    };
    // Saved before the first chunk: from here a stopped attempt skips
    // straight back to the rollup, the phases above having finished.
    await this.saveProgress(data, ctx, progress);
    return this.rollupPhase(data, ctx, progress, reconcileSummary, {
      attempted: priceSummary.attempted,
      inserted: priceSummary.inserted,
      alreadyHad: priceSummary.alreadyHad,
      providerMissing: priceSummary.providerMissing,
      droppedDays: priceSummary.droppedDays,
    });
  }

  private async saveProgress(
    data: PortfolioHistoryBackfillJob,
    ctx: ProcessorContext,
    progress: PortfolioHistoryRollupProgress
  ): Promise<void> {
    await ctx.job.updateData({ ...data, rollupProgress: progress });
  }

  private async rollupPhase(
    data: PortfolioHistoryBackfillJob,
    ctx: ProcessorContext,
    start: PortfolioHistoryRollupProgress,
    reconciliation: PortfolioHistoryBackfillResult['reconciliation'],
    prices: PortfolioHistoryBackfillResult['prices']
  ): Promise<PortfolioHistoryBackfillResult> {
    const rollup = Container.get(RollupPortfolioValueDailyUseCase);
    let deferredAtDayOffset: number | null = null;
    let rollupSummary: Awaited<ReturnType<typeof runChunkedRollup>>;
    try {
      rollupSummary = await runChunkedRollup(data.userId, data.lookbackDays, start, {
        rollup: (opts) => rollup.execute(opts),
        saveProgress: (progress) => this.saveProgress(data, ctx, progress),
        onChunk: (daysDone, total) => ctx.reportProgress(0.55 + 0.4 * (daysDone / total)),
        pace: {
          factor: BACKFILL_PACE_FACTOR,
          newerRequestPending: () =>
            newerBackfillPending(Container.get(QueueClient).get(), data.userId, ctx.job.id),
        },
        memoryStopReason: (fromDayOffset) => {
          const reading = readMemory();
          const reason = memoryStopReason(reading);
          const fields = { jobId: ctx.job.id, userId: data.userId, fromDayOffset, ...reading };
          if (reason) logger.warn({ ...fields, reason }, 'Stopping history rollup before a chunk');
          else logger.info(fields, 'Starting history rollup chunk');
          return reason;
        },
      });
    } catch (error) {
      if (!(error instanceof RollupMemoryStop)) throw error;
      // Not a failure: the window is saved and the rest of it is queued. The
      // throw this replaces spent BullMQ's one retry 30 seconds later against
      // the same process RSS, stopped at the same offset, and dead-lettered
      // the job with ~100 days never computed (SC-1298).
      ({ deferredAtDayOffset } = await handleMemoryStop(
        data,
        start.anchor,
        error,
        Container.get(BullMqEnqueueService)
      ));
      logger.warn(
        {
          jobId: ctx.job.id,
          userId: data.userId,
          deferredAtDayOffset,
          delayMs: MEMORY_DEFER_DELAY_MS,
          reason: error.message,
        },
        'History rollup deferred — continuation queued with progress'
      );
      rollupSummary = { usersProcessed: 0, daysComputed: 0, errors: [] };
    }
    await ctx.reportProgress(0.95);

    emitEntityChange({
      entityType: 'holding',
      operationType: 'update',
      entityId: data.userId,
      userId: data.userId,
      data: { reason: 'portfolio-history-backfill' },
    });

    await ctx.reportProgress(1);

    if (rollupSummary.errors.length > 0) {
      logger.warn(
        { jobId: ctx.job.id, errors: rollupSummary.errors },
        'Rollup completed with per-user errors'
      );
    }

    return {
      tokenCount: data.tokenIds.length,
      lookbackDays: data.lookbackDays,
      reconciliation,
      prices,
      rollup: {
        usersProcessed: rollupSummary.usersProcessed,
        daysComputed: rollupSummary.daysComputed,
        errorCount: rollupSummary.errors.length,
      },
      deferredAtDayOffset,
    };
  }

  private async reconcileUser(
    userId: string
  ): Promise<{ holdingsTouched: number; openingsSynthesized: number }> {
    try {
      const results = await Container.get(OpeningBalanceReconciliationService).reconcileUser(
        userId
      );
      const synthesized = results.filter((r) => r.openingBalanceSynthesized).length;
      return { holdingsTouched: results.length, openingsSynthesized: synthesized };
    } catch (error) {
      logger.warn(
        { userId, error: error instanceof Error ? error.message : error },
        'Reconciliation pass threw; continuing with backfill'
      );
      return { holdingsTouched: 0, openingsSynthesized: 0 };
    }
  }
}
