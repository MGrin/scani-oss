import type { JobEventPayload } from '../core/types';

// Best-effort fan-out of job lifecycle events to whatever pub/sub
// substrate the deployment uses (Redis pub/sub matching
// RealTimeUpdatesService' wire shape in production). Failures must not
// break the worker — the durable record is BullMQ + the LifecycleMirror,
// not the publish.
export abstract class LifecyclePublisher {
  abstract publish(userId: string, jobId: string, payload: JobEventPayload): Promise<void>;
}
