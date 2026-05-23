import { createComponentLogger } from '@scani/logging';

const monitorLogger = createComponentLogger('connection-monitor');

interface ConnectionMetrics {
  requestId: string;
  startTime: number;
  queriesExecuted: number;
  connectionAcquiredAt?: number;
  connectionReleasedAt?: number;
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

// Global query statistics
const queryStats = {
  totalQueries: 0,
  slowQueries: [] as Array<{
    query: string;
    duration: number;
    timestamp: Date;
    requestId?: string;
  }>,
  averageQueryTime: 0,
  maxQueryTime: 0,
};

const SLOW_QUERY_THRESHOLD_MS = 100;
const MAX_SLOW_QUERIES_STORED = 100;

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
    queriesExecuted: 0,
  });
}

/**
 * Record a connection acquisition
 */
export function recordConnectionAcquired(requestId: string): void {
  const metrics = requestMetrics.get(requestId);
  if (metrics) {
    metrics.connectionAcquiredAt = Date.now();
  }
}

/**
 * Record a connection release
 */
export function recordConnectionReleased(requestId: string): void {
  const metrics = requestMetrics.get(requestId);
  if (metrics) {
    metrics.connectionReleasedAt = Date.now();
  }
}

/**
 * Record a query execution
 */
export function recordQueryExecuted(
  requestId: string | undefined,
  query: string,
  durationMs: number
): void {
  // Update per-request metrics
  if (requestId) {
    const metrics = requestMetrics.get(requestId);
    if (metrics) {
      metrics.queriesExecuted++;
    }
  }

  // Update global statistics
  queryStats.totalQueries++;
  queryStats.maxQueryTime = Math.max(queryStats.maxQueryTime, durationMs);

  // Track running average
  const alpha = 0.1; // Exponential moving average factor
  queryStats.averageQueryTime = queryStats.averageQueryTime * (1 - alpha) + durationMs * alpha;

  // Track slow queries
  if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
    queryStats.slowQueries.push({
      query: query.substring(0, 200), // Truncate long queries
      duration: durationMs,
      timestamp: new Date(),
      requestId,
    });

    // Keep only last N slow queries
    if (queryStats.slowQueries.length > MAX_SLOW_QUERIES_STORED) {
      queryStats.slowQueries.shift();
    }

    monitorLogger.warn(
      {
        requestId,
        query: query.substring(0, 100),
        durationMs,
      },
      '🐌 Slow query detected'
    );
  }
}

/**
 * End connection tracking for a request and log metrics
 */
export function endConnectionTracking(requestId: string): void {
  const metrics = requestMetrics.get(requestId);
  if (!metrics) return;

  const totalTime = Date.now() - metrics.startTime;
  const connectionHoldTime =
    metrics.connectionAcquiredAt && metrics.connectionReleasedAt
      ? metrics.connectionReleasedAt - metrics.connectionAcquiredAt
      : undefined;

  // Log detailed metrics for requests that used database
  if (metrics.queriesExecuted > 0) {
    const logData = {
      requestId,
      totalRequestTime: `${totalTime}ms`,
      queriesExecuted: metrics.queriesExecuted,
      connectionHoldTime: connectionHoldTime ? `${connectionHoldTime}ms` : 'N/A',
      avgQueryTime: `${(totalTime / metrics.queriesExecuted).toFixed(2)}ms`,
    };

    // Warn if request executed many queries
    if (metrics.queriesExecuted > 10) {
      monitorLogger.warn(logData, '⚠️ Request executed many queries - potential N+1 pattern');
    } else {
      monitorLogger.debug(logData, '📊 Connection usage');
    }
  }

  // Clean up
  requestMetrics.delete(requestId);
}

/**
 * Get current connection monitoring statistics
 */
export function getConnectionMonitoringStats() {
  return {
    activeRequests: requestMetrics.size,
    totalQueries: queryStats.totalQueries,
    averageQueryTime: Math.round(queryStats.averageQueryTime),
    maxQueryTime: queryStats.maxQueryTime,
    slowQueriesCount: queryStats.slowQueries.length,
    recentSlowQueries: queryStats.slowQueries.slice(-10).map((q) => ({
      query: q.query,
      duration: q.duration,
      timestamp: q.timestamp,
    })),
  };
}

/**
 * Reset monitoring statistics (useful for testing)
 */
export function resetConnectionMonitoringStats(): void {
  requestMetrics.clear();
  queryStats.totalQueries = 0;
  queryStats.slowQueries = [];
  queryStats.averageQueryTime = 0;
  queryStats.maxQueryTime = 0;
}
