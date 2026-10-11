import type { JobsOptions } from 'bullmq';
import type { ZodType } from 'zod';
import type { UserJobBase } from './types';

export interface UserJobDescriptor<TPayload extends UserJobBase, TResult = unknown> {
  readonly name: string;
  readonly schema: ZodType<TPayload>;
  readonly defaultOpts: JobsOptions;
  computeJobId(data: TPayload): string;
  summarizePayload(data: TPayload): Record<string, unknown>;
  // Per-job override for result truncation; defaults to the framework's
  // ResultTruncator (32 KB). Override only when a specific job's payload
  // shape needs a different cap or shape-aware shrinking.
  sanitizeResult?(result: TResult): unknown;
}

export interface ScheduledJobDescriptor {
  readonly name: string;
  readonly cron: string;
  readonly timezone?: string;
  readonly defaultOpts?: JobsOptions;
  // When set, ScheduledJobProcessor wraps handle() in JobLock.tryAcquire.
  // Reconcile-* style sweepers (idempotent re-scans) leave this undefined.
  readonly lockName?: string;
  // Random delay (in ms) applied per fire before handle() runs. Useful
  // for `* * * * *` schedules running on multiple replicas: BullMQ fires
  // every replica's handler at the same wallclock second, which spikes
  // Postgres advisory-lock contention once a minute. With jitterMs the
  // base class draws `Math.random() * jitterMs` and waits before
  // dispatching, smoothing the load.
  readonly jitterMs?: number;
}

// One step of a grouped schedule (SC-1688): a scheduled job's lock, jitter
// and heartbeat name without a cron of its own. The group it belongs to owns
// the schedule.
export type ScheduledJobStepDescriptor = Pick<
  ScheduledJobDescriptor,
  'name' | 'lockName' | 'jitterMs'
>;

export interface ScheduledJobGroupStep {
  readonly name: string;
  // Restricts a step to some runs of its group, e.g. a weekly step in a
  // nightly group. Given the time the run started.
  readonly runOn?: (at: Date) => boolean;
  // Bound on one attempt. A step past it is recorded as timed out and the
  // group moves on; the bound does not cancel the step's work.
  readonly timeoutMs?: number;
}

// One repeatable schedule that runs its steps in order, each with its own
// lock, retry and heartbeat (SC-1688).
export interface ScheduledJobGroupDescriptor extends ScheduledJobDescriptor {
  readonly steps: readonly ScheduledJobGroupStep[];
}

// A user job carries a payload schema; a scheduled job, a group or a group
// step never does. A step has no cron (SC-1688), so the cron cannot say which
// side of the worker's capacity split a job belongs to.
export function isUserJobDescriptor(d: unknown): d is UserJobDescriptor<UserJobBase> {
  return typeof d === 'object' && d !== null && 'schema' in d;
}
