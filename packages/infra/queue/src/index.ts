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
export {
  ResourceLock,
  type ResourceLockAcquired,
  type ResourceLockBusy,
} from './consumer/resource-lock';
export { ScheduledJobProcessor } from './consumer/scheduled-job-processor';
export { UserJobProcessor } from './consumer/user-job-processor';
export {
  type TerminalFailureHook,
  WorkerClient,
  type WorkerClientConfig,
} from './consumer/worker-client';
export { DEFAULT_DLQ_NAME, DEFAULT_QUEUE_NAME } from './core/default-names';
export {
  isScheduledJobDescriptor,
  type ScheduledJobDescriptor,
  type UserJobDescriptor,
} from './core/job-descriptor';
export {
  DURABLE_RESULT_MAX_BYTES,
  ResultTruncator,
  readTruncationNotice,
  TRUNCATION_KEY,
  TRUNCATION_ROOT_FIELD,
  type TruncationNotice,
  WIRE_RESULT_MAX_BYTES,
} from './core/result-truncator';
export type {
  EnqueuedJobMeta,
  JobEventPayload,
  JobLifecycleState,
  LifecycleEvent,
  ProcessorContext,
  UserJobBase,
} from './core/types';
export { userFacing, userFacingMessage } from './core/user-facing';
export { LifecyclePublisher } from './lifecycle/lifecycle-publisher';
export { RedisLifecyclePublisher } from './lifecycle/redis-lifecycle-publisher';
export { PostgresResourceLock } from './locks/postgres-resource-lock';
export { RedisResourceLock } from './locks/redis-resource-lock';
export { runQueueMigrations } from './migrate';
export { BullMqEnqueueService } from './producer/bullmq-enqueue-service';
export { ENQUEUE_MIRROR, type EnqueueMirror } from './producer/enqueue-mirror';
export { EnqueueService } from './producer/enqueue-service';
export { JobScheduler } from './producer/job-scheduler';
export {
  DEFAULT_QUEUE_SCHEMA,
  QueueClient,
  type QueueClientConfig,
} from './producer/queue-client';
// SC-225 / SC-321. The bounded ping and the reachability tracker moved to
// `@scani/rate-limiter`, which the data-provider already depends on and this
// package's BullMQ weight made unusable there. Both are zero-import pure
// logic and both are upstream-boundary resilience primitives, which is what
// that package is for. Importers take them from `@scani/rate-limiter`.

// SC-298. An opt-in boot assertion for the bindings a deployment requires.
// The `catch { return null }` at each resolve site stays — it is correct for
// OSS and tests — and this is how a managed deployment says it is not one of
// them, without changing anything for the deployments that are.
export {
  assertQueueBindings,
  isQueueBindingRegistered,
  type QueueBinding,
} from './required-bindings';
