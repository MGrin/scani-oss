// Re-export BullMQ's UnrecoverableError so processors signal "don't
// retry" without depending on the bullmq package directly. JobsOptions
// is also re-exported so descriptor packages can declare `defaultOpts`
// without taking a direct dependency on bullmq.

export type { JobsOptions } from 'bullmq';
export { UnrecoverableError } from 'bullmq';
export {
  JOB_HEARTBEAT_WRITER,
  JobHeartbeatWriter,
  type JobRunOutcome,
} from './consumer/job-heartbeat-writer';
export {
  JOB_LOCK,
  JobLock,
  type JobLockAcquired,
  type JobLockSkipped,
} from './consumer/job-lock';
export { LIFECYCLE_MIRROR, type LifecycleMirror } from './consumer/lifecycle-mirror';
export { ResourceLock } from './consumer/resource-lock';
export { ScheduledJobProcessor } from './consumer/scheduled-job-processor';
export { UserJobProcessor } from './consumer/user-job-processor';
export { WorkerClient } from './consumer/worker-client';
export { DEFAULT_DLQ_NAME, DEFAULT_QUEUE_NAME } from './core/default-names';
export type {
  ScheduledJobDescriptor,
  UserJobDescriptor,
} from './core/job-descriptor';
export { reasonLine } from './core/reason-line';
export { jobDeathReason, sourceUnavailable } from './core/source-unavailable';
export type {
  EnqueuedJobMeta,
  LifecycleEvent,
  ProcessorContext,
  UserJobBase,
} from './core/types';
export { userFacing, userFacingMessage } from './core/user-facing';
export { RedisLifecyclePublisher } from './lifecycle/redis-lifecycle-publisher';
export { PostgresResourceLock } from './locks/postgres-resource-lock';
export { runQueueMigrations } from './migrate';
export { BullMqEnqueueService } from './producer/bullmq-enqueue-service';
export { ENQUEUE_MIRROR, type EnqueueMirror } from './producer/enqueue-mirror';
export { JobScheduler } from './producer/job-scheduler';
export { QueueClient } from './producer/queue-client';
export { serveWorkerWake, WorkerWakeClient } from './wake/worker-wake';
// SC-225 / SC-321. The bounded ping and the reachability tracker moved to
// `@scani/rate-limiter`, which the data-provider already depends on and this
// package's BullMQ weight made unusable there. Both are zero-import pure
// logic and both are upstream-boundary resilience primitives, which is what
// that package is for. Importers take them from `@scani/rate-limiter`.

// SC-298. An opt-in boot assertion for the bindings a deployment requires.
// The `catch { return null }` at each resolve site stays — it is correct for
// OSS and tests — and this is how a managed deployment says it is not one of
// them, without changing anything for the deployments that are.
export { assertQueueBindings } from './required-bindings';
