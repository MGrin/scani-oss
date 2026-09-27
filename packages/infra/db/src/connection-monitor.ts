interface ConnectionMetrics {
  requestId: string;
  startTime: number;
}

// Store per-request metrics. Bounded to MAX_TRACKED_REQUESTS so an
// unmatched startConnectionTracking (handler that throws past the
// onError cleanup, OPTIONS preflight skipped by `onAfterHandle`, …)
// can't grow unbounded — every entry past the cap evicts the oldest.
// Per-entry footprint is small (~100 bytes), so a 5_000-entry cap
// limits the worst case to ~500 KB on the hot path.
const MAX_TRACKED_REQUESTS = 5_000;
const STALE_REQUEST_AGE_MS = 60 * 60 * 1000; // 1 h
const requestMetrics = new Map<string, ConnectionMetrics>();

/**
 * Start tracking connection usage for a request. Defensive: when the
 * Map exceeds MAX_TRACKED_REQUESTS, evict in two passes — first prune
 * entries older than STALE_REQUEST_AGE_MS (the most likely leak source
 * — a handler that errored without `endConnectionTracking`), then if
 * still over cap drop the oldest insertion-ordered entries.
 */
export function startConnectionTracking(requestId: string): void {
  if (requestMetrics.size >= MAX_TRACKED_REQUESTS) {
    const cutoff = Date.now() - STALE_REQUEST_AGE_MS;
    for (const [id, m] of requestMetrics) {
      if (m.startTime < cutoff) requestMetrics.delete(id);
    }
    if (requestMetrics.size >= MAX_TRACKED_REQUESTS) {
      const dropTarget = MAX_TRACKED_REQUESTS - Math.floor(MAX_TRACKED_REQUESTS / 4);
      for (const id of requestMetrics.keys()) {
        if (requestMetrics.size <= dropTarget) break;
        requestMetrics.delete(id);
      }
    }
  }
  requestMetrics.set(requestId, {
    requestId,
    startTime: Date.now(),
  });
}

export function endConnectionTracking(requestId: string): void {
  requestMetrics.delete(requestId);
}

export function getConnectionMonitoringStats() {
  return {
    activeRequests: requestMetrics.size,
    // Drizzle's logger runs before execution and postgres-js exposes no pool
    // acquisition hook. Neither logging time nor request time measures these.
    queryTiming: null,
    poolWaitTime: null,
    timingStatus: 'not_instrumented' as const,
  };
}
