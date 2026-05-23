// Per-resource TTL-bounded lock — different from JobLock (which is per
// job-name and session-scoped). ResourceLock keys by an arbitrary
// resource id (e.g., a holdingId) and auto-expires after `ttlMs` so a
// crashed holder doesn't block forever.
//
// Used by jobs that race per-resource: `holding-price-update` for a
// given holdingId can fire from multiple paths (manual update,
// scheduled refresh) and the recompute should run once per resource
// per short window.
//
// Returns `{ ok: false }` when the resource is locked — caller skips
// silently (the holder will publish the result the second caller would
// have produced).
export interface ResourceLockAcquired {
  ok: true;
  release: () => Promise<void>;
}
export interface ResourceLockBusy {
  ok: false;
}

export abstract class ResourceLock {
  abstract acquire(key: string, ttlMs: number): Promise<ResourceLockAcquired | ResourceLockBusy>;
}
