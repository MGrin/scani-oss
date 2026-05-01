import { Token } from 'typedi';
import type { EnqueuedJobMeta } from '../core/types';

// Domain-side hook so the framework can persist a mirror row before
// BullMQ.add (and clean up if the add throws). Domain provides the
// concrete via `Container.set(ENQUEUE_MIRROR, impl)` at boot.
//
// When unset, the framework just enqueues without mirroring — useful
// for tests and Tier-1 OSS deploys that don't track per-user job state.
export interface EnqueueMirror {
  onEnqueued(meta: EnqueuedJobMeta): Promise<void>;
  onEnqueueFailed(
    jobId: string,
    error: Error,
    meta: Omit<EnqueuedJobMeta, 'payloadSummary'>
  ): Promise<void>;
}

export const ENQUEUE_MIRROR = new Token<EnqueueMirror>('queue.enqueue-mirror');
