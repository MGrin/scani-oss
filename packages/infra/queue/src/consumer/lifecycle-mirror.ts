import { Token } from 'typedi';
import type { LifecycleEvent } from '../core/types';

// Domain-side hook so the framework can persist every lifecycle
// transition (active / progress / completed / failed) into a durable
// table. Domain provides the concrete via `Container.set(LIFECYCLE_MIRROR, impl)`.
//
// When unset, lifecycle events are still published over Redis pub/sub
// for live UI updates — only the durable mirror is skipped. Useful for
// Tier-1 OSS deploys without a per-user job table.
export interface LifecycleMirror {
  onLifecycle(event: LifecycleEvent): Promise<void>;
}

export const LIFECYCLE_MIRROR = new Token<LifecycleMirror>('queue.lifecycle-mirror');
