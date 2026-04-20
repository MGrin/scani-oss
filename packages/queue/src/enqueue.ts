/**
 * Typed enqueue helper for user-initiated BullMQ jobs — domain-free.
 *
 * The orchestration here (deterministic jobId, default retry policy, dedup
 * on jobId) is the generic part of enqueue. Anything domain-specific (the
 * `user_jobs` mirror row) is injected via callbacks so this module can
 * live in `@scani/queue` without importing `@scani/domain`.
 *
 * Consumers call `createEnqueue(...)` once at startup with their DB hooks
 * and use the returned `enqueueJob` the same way they used the old, DI-bound
 * helper.
 */

import { createHash } from 'node:crypto';
import type { JobsOptions, Queue } from 'bullmq';
import { JOB_NAMES } from './queue-names';
import { summarizePayload } from './summarize-payload';
import type {
  ExchangeImportJob,
  FileImportJob,
  HoldingPriceUpdateJob,
  ScreenshotParseJob,
  UserDataDeleteJob,
  WalletImportJob,
} from './types';

type UserJobName =
  | typeof JOB_NAMES.screenshotParse
  | typeof JOB_NAMES.exchangeImport
  | typeof JOB_NAMES.walletImport
  | typeof JOB_NAMES.fileImport
  | typeof JOB_NAMES.holdingPriceUpdate
  | typeof JOB_NAMES.userDataDelete;

type UserJobDataMap = {
  [JOB_NAMES.screenshotParse]: ScreenshotParseJob;
  [JOB_NAMES.exchangeImport]: ExchangeImportJob;
  [JOB_NAMES.walletImport]: WalletImportJob;
  [JOB_NAMES.fileImport]: FileImportJob;
  [JOB_NAMES.holdingPriceUpdate]: HoldingPriceUpdateJob;
  [JOB_NAMES.userDataDelete]: UserDataDeleteJob;
};

const DEFAULT_OPTS: Record<UserJobName, JobsOptions> = {
  [JOB_NAMES.screenshotParse]: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  [JOB_NAMES.exchangeImport]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  [JOB_NAMES.walletImport]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  [JOB_NAMES.fileImport]: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  [JOB_NAMES.holdingPriceUpdate]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  [JOB_NAMES.userDataDelete]: {
    // Destructive: do not retry on failure — surface the error.
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
};

const JOB_ID_SEP = '_';

/**
 * Build a deterministic jobId per job family. BullMQ dedupes adds with the
 * same jobId, giving us free idempotency on double-submits. Including
 * `requestId` (a client UUID) means a legitimate re-submission produces a
 * fresh id while accidental duplicates collapse.
 *
 * BullMQ rejects any custom job id containing ':' (used internally as a Redis
 * key separator), so all parts are joined with '_' instead. UUIDs use '-',
 * EVM addresses are hex, and our job names are kebab-case — none collide.
 */
export function computeJobId<Name extends UserJobName>(
  name: Name,
  data: UserJobDataMap[Name]
): string {
  switch (name) {
    case JOB_NAMES.walletImport: {
      const d = data as WalletImportJob;
      return [name, d.userId, d.chain, d.address.toLowerCase(), d.requestId].join(JOB_ID_SEP);
    }
    case JOB_NAMES.screenshotParse: {
      const d = data as ScreenshotParseJob;
      const keyDigest = createHash('sha256').update(d.r2Keys.join('|')).digest('hex').slice(0, 16);
      return [name, d.userId, keyDigest, d.requestId].join(JOB_ID_SEP);
    }
    case JOB_NAMES.exchangeImport: {
      const d = data as ExchangeImportJob;
      return [name, d.userId, d.institutionId, d.requestId].join(JOB_ID_SEP);
    }
    case JOB_NAMES.fileImport: {
      const d = data as FileImportJob;
      return [name, d.userId, d.accountId, d.requestId].join(JOB_ID_SEP);
    }
    case JOB_NAMES.holdingPriceUpdate: {
      const d = data as HoldingPriceUpdateJob;
      return [name, d.userId, d.holdingId, d.requestId].join(JOB_ID_SEP);
    }
    case JOB_NAMES.userDataDelete: {
      const d = data as UserDataDeleteJob;
      return [name, d.userId, d.requestId].join(JOB_ID_SEP);
    }
    default: {
      const _exhaustive: never = name;
      throw new Error(`No jobId strategy for job '${_exhaustive}'`);
    }
  }
}

/** Snapshot handed to the domain's onEnqueued hook. */
export interface EnqueuedJobMeta {
  jobId: string;
  userId: string;
  jobName: UserJobName;
  payloadSummary: Record<string, unknown>;
  attemptsAllowed: number;
}

export interface CreateEnqueueOptions {
  /** Returns the configured BullMQ Queue. Lazily called per enqueue. */
  getQueue: () => Queue;
  /**
   * Fired BEFORE `queue.add`. The domain typically inserts a mirror row
   * here (idempotent on `jobId`) so the worker's lifecycle writes always
   * have a target.
   */
  onEnqueued: (job: EnqueuedJobMeta) => Promise<void>;
  /**
   * Fired when `queue.add` throws. Lets the domain mark the row failed so
   * the UI surfaces the enqueue failure rather than leaving a ghost row
   * stuck in `queued` forever.
   */
  onEnqueueFailed: (
    jobId: string,
    error: Error,
    meta: Omit<EnqueuedJobMeta, 'payloadSummary'>
  ) => Promise<void>;
}

export type EnqueueJobFn = <Name extends UserJobName>(
  name: Name,
  data: UserJobDataMap[Name],
  overrides?: JobsOptions
) => Promise<string>;

export function createEnqueue(options: CreateEnqueueOptions): EnqueueJobFn {
  const { getQueue, onEnqueued, onEnqueueFailed } = options;

  return async function enqueueJob<Name extends UserJobName>(
    name: Name,
    data: UserJobDataMap[Name],
    overrides?: JobsOptions
  ): Promise<string> {
    const queue = getQueue();
    const jobId = computeJobId(name, data);
    const opts: JobsOptions = {
      jobId,
      ...DEFAULT_OPTS[name],
      ...overrides,
    };
    const attemptsAllowed = (opts.attempts as number | undefined) ?? 1;

    await onEnqueued({
      jobId,
      userId: data.userId,
      jobName: name,
      payloadSummary: summarizePayload(name, data),
      attemptsAllowed,
    });

    try {
      await queue.add(name, data, opts);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await onEnqueueFailed(jobId, error, {
        userId: data.userId,
        jobName: name,
        attemptsAllowed,
        jobId,
      });
      throw err;
    }
    return jobId;
  };
}
