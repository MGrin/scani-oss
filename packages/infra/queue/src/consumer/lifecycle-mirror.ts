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

  /**
   * Has this job been cancelled by its owner? Replaces BullMQ's
   * `Job#discard()`, which v6 removed (the release notes say "use
   * UnrecoverableError instead", which is a processor-side mechanism — there
   * is no longer any way to stop retries from outside the worker).
   *
   * `discard()` was load-bearing, not decorative: cancelling an ACTIVE job
   * cannot remove it from the queue, and user jobs really do retry
   * (`transaction-import` has `attempts: 4`, `screenshot-parse` 2). Without a
   * replacement, cancelling an active import would let it run again — real
   * side effects, twice, after the user asked it to stop.
   *
   * Checking the durable mirror is strictly stronger than `discard()` was: it
   * stops the *current* attempt as well as later ones, and it is
   * backend-agnostic, so it survives the move to Postgres unchanged.
   *
   * Optional: a deployment with no durable job table has no mirror, and there
   * the processor keeps exactly the behaviour it has today.
   */
  isCancelled?(jobId: string): Promise<boolean>;
}

export const LIFECYCLE_MIRROR = new Token<LifecycleMirror>('queue.lifecycle-mirror');
