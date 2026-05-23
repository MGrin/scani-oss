/**
 * Pluggable per-request usage sink.
 *
 * Implementations:
 *   - `NoopUsageSink` — Tier 1 OSS default (no metering).
 *   - `PostgresUsageSink` — Tier 2/3. Buffers rows in memory and flushes
 *     batches into `cloud_usage_events` in the shared Neon database.
 */

import { cloudUsageEvents } from '@scani/db';
import { logger } from '@scani/logging';

import type { CloudDb } from '../db/connection';

export type UsageOutcome = 'ok' | 'error' | 'rate_limited' | 'unauthorized' | 'quota_exceeded';

export interface UsageEvent {
  /** Cloud API key the request authenticated with (null for OSS env-key). */
  apiKeyId: string | null;
  /** Tenant the key belongs to (null for OSS / dev). */
  tenantId: string | null;
  /**
   * Billable subject — for Tier 2 this is the `cloud_users.id`. For OSS
   * this is null and the event is not recorded.
   */
  subject: string | null;
  requestId: string | null;
  route: string;
  provider: string;
  outcome: UsageOutcome;
  statusCode?: number;
  durationMs: number;
  tokensIn?: number;
  tokensOut?: number;
  bytesIn?: number;
  bytesOut?: number;
  upstreamCostUsd?: number;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageSink {
  record(event: UsageEvent): void | Promise<void>;
  flush(): Promise<void>;
}

/** Zero-sink for OSS Tier 1 (no metering). */
export class NoopUsageSink implements UsageSink {
  record(_event: UsageEvent): void {}
  async flush(): Promise<void> {}
}

type UsageRow = typeof cloudUsageEvents.$inferInsert;

/**
 * Postgres-backed sink. Buffers in memory and flushes in batches. Non-blocking
 * for the request path; on shutdown, `flush()` drains the buffer.
 */
export class PostgresUsageSink implements UsageSink {
  private buffer: UsageRow[] = [];
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly db: CloudDb;

  constructor(options: { db: CloudDb; batchSize?: number; flushIntervalMs?: number }) {
    this.db = options.db;
    this.batchSize = options.batchSize ?? 100;
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
  }

  record(event: UsageEvent): void {
    if (!event.subject) {
      return;
    }
    this.buffer.push({
      subject: event.subject,
      apiKeyId: event.apiKeyId,
      tenantId: event.tenantId,
      requestId: event.requestId,
      route: event.route,
      provider: event.provider,
      outcome: event.outcome,
      statusCode: event.statusCode,
      durationMs: event.durationMs,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      bytesIn: event.bytesIn,
      bytesOut: event.bytesOut,
      upstreamCostUsd: event.upstreamCostUsd,
      errorCode: event.errorCode,
      metadata: event.metadata ?? null,
    });
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const toSend = this.buffer;
    this.buffer = [];
    try {
      await this.db.insert(cloudUsageEvents).values(toSend);
    } catch (err) {
      logger.error(
        { err, dropped: toSend.length },
        'usage-sink: failed to flush batch to Postgres'
      );
    }
  }
}
