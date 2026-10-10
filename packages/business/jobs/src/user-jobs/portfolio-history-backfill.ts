import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';
import { RETRY_HEAVY } from '../retry-policies';

// Days of history a full portfolio-history recompute materializes.
// MUST exceed the longest chart window the UI offers (1Y = 365 days)
// with margin. The rollup loop produces `lookbackDays` calendar days
// ending today, so it reaches back only `lookbackDays - 1` days; the
// 1Y chart requests `today - 365d`. At 365 the chart's oldest point
// landed one day past the rollup's reach and rendered a stale
// pre-recompute row, which the PnL chart's window re-basing then
// anchored the entire curve to. 400 leaves a comfortable buffer.
export const PORTFOLIO_HISTORY_LOOKBACK_DAYS = 400;

// Days the rollup walks per step (SC-1283). A 400-day window rolled up in one
// pass ran the 1 GB worker out of memory; each step now writes its rows and
// releases them before the next, and records how far it got.
export const PORTFOLIO_HISTORY_CHUNK_DAYS = 30;

// Where an interrupted run stopped. Written into the job's own data after
// every chunk, so a stalled attempt restarts at the next chunk instead of at
// day 0. `anchor` is the frozen "now" the window was laid out from; a resume
// reuses it so the remaining chunks land on the same day boundaries.
export interface PortfolioHistoryRollupProgress {
  anchor: string;
  nextDayOffset: number;
}

export interface PortfolioHistoryBackfillJob extends UserJobBase {
  // Tokens to backfill historical prices for. Empty array → no-op,
  // since the rollup phase still runs and uses whatever prices exist.
  tokenIds: string[];
  // Days of history to materialize. Manual-create flow uses 365.
  lookbackDays: number;
  rollupProgress?: PortfolioHistoryRollupProgress;
  // The delay a lock-held retry was armed with, so the next re-arm backs off
  // from it instead of polling a long holder every 90s (SC-1595).
  lockHeldDelayMs?: number;
  // The earliest UTC day the triggering change can move (SC-1607). The job
  // rebuilds from here to today rather than the whole `lookbackDays`, and
  // widens it to whatever its own phases change earlier. Absent means the
  // whole window, and a merge with an absent one stays absent.
  fromDay?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Days the rollup walks to reach `fromDay`, counted from the anchor the window
 * is laid out from: offset 0 is the anchor's own day. Never wider than the
 * full-history `upperBound` the enqueue read, never less than today.
 */
export function rebuildWindowDays(
  upperBound: number,
  fromDay: string | undefined,
  anchor: Date
): number {
  if (fromDay === undefined) return upperBound;
  const days =
    (Date.parse(`${utcDay(anchor)}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`)) /
    DAY_MS;
  return Math.min(upperBound, Math.max(1, days + 1));
}

/** `fromDay` moved to the earliest of `changedAt`; a whole-window request stays whole. */
export function earliestFromDay(
  fromDay: string | undefined,
  ...changedAt: Array<Date | null | undefined>
): string | undefined {
  if (fromDay === undefined) return undefined;
  let earliest = fromDay;
  for (const at of changedAt) {
    if (!at) continue;
    const day = utcDay(at);
    if (day < earliest) earliest = day;
  }
  return earliest;
}

/** Two requests coalesced into one job: the earlier start wins, and whole wins over any start. */
export function mergeFromDay(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined || b === undefined) return undefined;
  return a < b ? a : b;
}

/** A start day that is absent means the whole window, so the field is dropped, not set to undefined. */
export function withFromDay<T extends object>(payload: T, fromDay: string | undefined): T {
  return fromDay === undefined ? payload : { ...payload, fromDay };
}

// What the coalescing enqueue needs of a queue: the add, whether a job is
// running, and a pending job's payload to read and rewrite.
export interface BackfillQueue {
  add: (
    descriptor: typeof PORTFOLIO_HISTORY_BACKFILL,
    payload: PortfolioHistoryBackfillJob,
    opts?: { delay?: number }
  ) => Promise<unknown>;
  getJobState: (jobId: string) => Promise<string>;
  getJobData?: (jobId: string) => Promise<PortfolioHistoryBackfillJob | undefined>;
  updateJobData?: (jobId: string, data: PortfolioHistoryBackfillJob) => Promise<void>;
}

/** The adapter over BullMQ's enqueue service and queue. */
export function backfillQueueOf(
  enqueue: { add: BackfillQueue['add'] },
  queue: {
    getJobState(jobId: string): Promise<string>;
    getJob(
      jobId: string
    ): Promise<{ data: unknown; updateData(data: unknown): Promise<unknown> } | undefined>;
  }
): BackfillQueue {
  return {
    add: (descriptor, payload, opts) => enqueue.add(descriptor, payload, opts),
    getJobState: (jobId) => queue.getJobState(jobId),
    getJobData: async (jobId) =>
      (await queue.getJob(jobId))?.data as PortfolioHistoryBackfillJob | undefined,
    updateJobData: async (jobId, data) => {
      await (await queue.getJob(jobId))?.updateData(data);
    },
  };
}

const COALESCE_SLOTS = 3;
const PENDING_STATES = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children']);

// A pending job takes the earlier start day and the wider lookback of whatever
// joins it, so neither request's oldest days are dropped (SC-1323, SC-1607).
async function absorbWindow(
  queue: BackfillQueue,
  jobId: string,
  joining: Pick<PortfolioHistoryBackfillJob, 'fromDay' | 'lookbackDays'>
): Promise<void> {
  if (!queue.getJobData || !queue.updateJobData) return;
  const pending = await queue.getJobData(jobId);
  if (!pending) return;
  const fromDay = mergeFromDay(pending.fromDay, joining.fromDay);
  const lookbackDays = Math.max(pending.lookbackDays, joining.lookbackDays);
  if (fromDay === pending.fromDay && lookbackDays === pending.lookbackDays) return;
  const { fromDay: _replaced, ...rest } = pending;
  await queue.updateJobData(jobId, withFromDay({ ...rest, lookbackDays }, fromDay));
}

/**
 * Enqueue a history rebuild that never lands on a RUNNING one. An add onto an
 * active job id is dropped by `add_job`'s ON CONFLICT, and that run's snapshot
 * may predate the trigger, so the rebuild would be lost (SC-1592). So the add
 * takes the first of `base`, `base-2`, `base-3` whose job is not active: a
 * pending one coalesces and takes the earlier start day and the wider lookback
 * (SC-1607), a finished one is evicted by the enqueue service. With all three
 * running, a unique id is never coalesced and never dropped.
 */
export async function enqueueCoalescedBackfill(
  queue: BackfillQueue,
  base: string,
  payloadFor: (requestId: string) => PortfolioHistoryBackfillJob,
  opts?: { delay?: number }
): Promise<void> {
  let requestId: string | null = null;
  for (let slot = 1; slot <= COALESCE_SLOTS && requestId === null; slot++) {
    const candidate = slot === 1 ? base : `${base}-${slot}`;
    const payload = payloadFor(candidate);
    const jobId = PORTFOLIO_HISTORY_BACKFILL.computeJobId(payload);
    const state = await queue.getJobState(jobId);
    if (state === 'active') continue;
    requestId = candidate;
    // The add below is a no-op onto a pending job, so its start day and width
    // are moved onto that job instead.
    if (PENDING_STATES.has(state)) await absorbWindow(queue, jobId, payload);
  }
  requestId ??= `${base}-${Date.now()}`;
  await queue.add(PORTFOLIO_HISTORY_BACKFILL, payloadFor(requestId), opts);
}

const portfolioHistoryBackfillSchema: z.ZodType<PortfolioHistoryBackfillJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  tokenIds: z.array(z.string().uuid()),
  lookbackDays: z
    .number()
    .int()
    .min(1)
    .max(365 * 100),
  rollupProgress: z
    .object({
      anchor: z.string().datetime(),
      nextDayOffset: z.number().int().min(0),
    })
    .optional(),
  lockHeldDelayMs: z.number().int().min(0).optional(),
  fromDay: z.string().date().optional(),
});

export const PORTFOLIO_HISTORY_BACKFILL: UserJobDescriptor<PortfolioHistoryBackfillJob> = {
  name: JOB_NAMES.portfolioHistoryBackfill,
  schema: portfolioHistoryBackfillSchema,
  defaultOpts: {
    ...RETRY_HEAVY,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => [JOB_NAMES.portfolioHistoryBackfill, d.userId, d.requestId].join('_'),
  summarizePayload: (d) => ({
    tokenCount: d.tokenIds.length,
    lookbackDays: d.lookbackDays,
  }),
};
