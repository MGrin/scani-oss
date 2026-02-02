import { createComponentLogger } from './logger';

const logger = createComponentLogger('performance');

/**
 * Performance Monitoring Utility
 * Tracks and reports on slow operations for debugging and optimization
 */

interface OperationMetric {
  name: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  slowCount: number; // Operations exceeding threshold
}

interface PerformanceConfig {
  slowThresholdMs: number;
  logSlowOperations: boolean;
  enabled: boolean;
}

const DEFAULT_CONFIG: PerformanceConfig = {
  slowThresholdMs: 1000, // 1 second
  logSlowOperations: true,
  enabled: process.env.NODE_ENV !== 'production' || process.env.ENABLE_PERF_MONITOR === 'true',
};

class PerformanceMonitor {
  private metrics = new Map<string, OperationMetric>();
  private config: PerformanceConfig;

  constructor(config: Partial<PerformanceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Track an operation's execution time
   */
  async track<T>(name: string, operation: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      return operation();
    }

    const start = performance.now();
    try {
      return await operation();
    } finally {
      const durationMs = performance.now() - start;
      this.recordMetric(name, durationMs);
    }
  }

  /**
   * Synchronous version of track
   */
  trackSync<T>(name: string, operation: () => T): T {
    if (!this.config.enabled) {
      return operation();
    }

    const start = performance.now();
    try {
      return operation();
    } finally {
      const durationMs = performance.now() - start;
      this.recordMetric(name, durationMs);
    }
  }

  /**
   * Record a metric for an operation
   */
  private recordMetric(name: string, durationMs: number): void {
    const existing = this.metrics.get(name);
    const isSlow = durationMs > this.config.slowThresholdMs;

    if (existing) {
      existing.count++;
      existing.totalMs += durationMs;
      existing.minMs = Math.min(existing.minMs, durationMs);
      existing.maxMs = Math.max(existing.maxMs, durationMs);
      existing.avgMs = existing.totalMs / existing.count;
      if (isSlow) existing.slowCount++;
    } else {
      this.metrics.set(name, {
        name,
        count: 1,
        totalMs: durationMs,
        minMs: durationMs,
        maxMs: durationMs,
        avgMs: durationMs,
        slowCount: isSlow ? 1 : 0,
      });
    }

    // Log slow operations
    if (isSlow && this.config.logSlowOperations) {
      logger.warn(
        {
          operation: name,
          durationMs: Math.round(durationMs),
          threshold: this.config.slowThresholdMs,
        },
        `Slow operation detected: ${name}`
      );
    }
  }

  /**
   * Get all collected metrics
   */
  getMetrics(): OperationMetric[] {
    return Array.from(this.metrics.values()).map((m) => ({
      ...m,
      avgMs: Math.round(m.avgMs * 100) / 100,
      minMs: Math.round(m.minMs * 100) / 100,
      maxMs: Math.round(m.maxMs * 100) / 100,
      totalMs: Math.round(m.totalMs * 100) / 100,
    }));
  }

  /**
   * Get metrics for a specific operation
   */
  getMetric(name: string): OperationMetric | undefined {
    const metric = this.metrics.get(name);
    if (!metric) return undefined;

    return {
      ...metric,
      avgMs: Math.round(metric.avgMs * 100) / 100,
      minMs: Math.round(metric.minMs * 100) / 100,
      maxMs: Math.round(metric.maxMs * 100) / 100,
      totalMs: Math.round(metric.totalMs * 100) / 100,
    };
  }

  /**
   * Get a summary of all metrics, sorted by average time
   */
  getSummary(): {
    totalOperations: number;
    slowOperations: number;
    slowestOperations: OperationMetric[];
    mostFrequentOperations: OperationMetric[];
  } {
    const metrics = this.getMetrics();
    const totalOperations = metrics.reduce((sum, m) => sum + m.count, 0);
    const slowOperations = metrics.reduce((sum, m) => sum + m.slowCount, 0);

    return {
      totalOperations,
      slowOperations,
      slowestOperations: [...metrics].sort((a, b) => b.avgMs - a.avgMs).slice(0, 10),
      mostFrequentOperations: [...metrics].sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics.clear();
  }

  /**
   * Log current metrics summary
   */
  logSummary(): void {
    if (!this.config.enabled) return;

    const summary = this.getSummary();
    logger.info(
      {
        totalOperations: summary.totalOperations,
        slowOperations: summary.slowOperations,
        slowestOperations: summary.slowestOperations.map((m) => ({
          name: m.name,
          avgMs: m.avgMs,
          count: m.count,
        })),
      },
      'Performance metrics summary'
    );
  }
}

// Singleton instance for global use
export const performanceMonitor = new PerformanceMonitor();

// Export class for custom instances
export { PerformanceMonitor, type PerformanceConfig, type OperationMetric };

/**
 * Decorator-style helper for tracking class methods
 * Usage:
 *   const result = await trackOperation('myOperation', () => someAsyncOperation());
 */
export function trackOperation<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return performanceMonitor.track(name, operation);
}

/**
 * Sync version
 */
export function trackOperationSync<T>(name: string, operation: () => T): T {
  return performanceMonitor.trackSync(name, operation);
}
