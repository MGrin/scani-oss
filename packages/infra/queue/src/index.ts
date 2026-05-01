// Re-export BullMQ's UnrecoverableError so processors signal "don't
// retry" without depending on the bullmq package directly.
export { UnrecoverableError } from 'bullmq';
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
export { ResultTruncator } from './core/result-truncator';
export type {
  EnqueuedJobMeta,
  JobEventPayload,
  JobLifecycleState,
  LifecycleEvent,
  ProcessorContext,
  UserJobBase,
} from './core/types';
export { LifecyclePublisher } from './lifecycle/lifecycle-publisher';
export { RedisLifecyclePublisher } from './lifecycle/redis-lifecycle-publisher';
export { RedisResourceLock } from './locks/redis-resource-lock';
export { BullMqEnqueueService } from './producer/bullmq-enqueue-service';
export { ENQUEUE_MIRROR, type EnqueueMirror } from './producer/enqueue-mirror';
export { EnqueueService } from './producer/enqueue-service';
export { JobScheduler } from './producer/job-scheduler';
export { QueueClient, type QueueClientConfig } from './producer/queue-client';
