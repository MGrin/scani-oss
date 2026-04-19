/**
 * Typed enqueue helper for user-initiated BullMQ jobs.
 *
 * Routers call `enqueueJob('wallet-import', { userId, address, ... })` and get
 * back a jobId they return to the client. The helper:
 *
 *  - computes a deterministic jobId from the payload so rapid duplicate
 *    submissions (double-click) collapse to a single job by BullMQ's jobId
 *    dedup — **without** a manual "already pending" check;
 *  - applies a family-appropriate retry/backoff policy via `DEFAULT_OPTS`;
 *  - applies `removeOnComplete`/`removeOnFail` caps consistent with the
 *    worker bootstrap (`apps/worker/src/index.ts`).
 *
 * Only user-initiated jobs flow through here. Scheduled jobs are registered
 * by the worker via `upsertJobScheduler()` and never enqueued from backend.
 */

import { createHash } from 'node:crypto';
import type {
  ExchangeImportJob,
  FileImportJob,
  HoldingPriceUpdateJob,
  ScreenshotParseJob,
  UserDataDeleteJob,
  WalletImportJob,
} from '@scani/core/queues';
import { JOB_NAMES } from '@scani/core/queues';
import type { JobsOptions } from 'bullmq';
import { getQueue } from './client';

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
const JOB_ID_SEP = '_';

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

export async function enqueueJob<Name extends UserJobName>(
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
  await queue.add(name, data, opts);
  return jobId;
}
