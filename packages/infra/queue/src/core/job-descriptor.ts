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

// Type guard used by WorkerClient / JobScheduler when iterating mixed
// descriptor lists.
export function isScheduledJobDescriptor(d: unknown): d is ScheduledJobDescriptor {
  return (
    typeof d === 'object' &&
    d !== null &&
    typeof (d as ScheduledJobDescriptor).cron === 'string' &&
    typeof (d as ScheduledJobDescriptor).name === 'string'
  );
}
