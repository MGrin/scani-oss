import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Per-scheduled-job liveness state. The worker upserts on every run
// (success or failure); a heartbeat-probe job pages via Sentry if any
// configured job's `lastSuccessAt` falls behind expected interval.
export const jobHeartbeats = pgTable('job_heartbeats', {
  jobName: text('job_name').primaryKey(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }).notNull(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastDurationMs: integer('last_duration_ms'),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type JobHeartbeat = typeof jobHeartbeats.$inferSelect;
export type NewJobHeartbeat = typeof jobHeartbeats.$inferInsert;
