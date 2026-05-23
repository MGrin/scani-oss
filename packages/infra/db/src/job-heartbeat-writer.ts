import { sql } from 'drizzle-orm';
import { db } from './connection';
import { jobHeartbeats } from './schema/job-heartbeats';

// Upsert a single heartbeat row. Called from `@scani/queue`'s
// ScheduledJobProcessor on every run. Failures are swallowed and
// surfaced via console.warn — a heartbeat write that fails must not
// take down the actual job that just succeeded.

export interface UpsertJobHeartbeatInput {
  jobName: string;
  startedAt: Date;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
}

export async function upsertJobHeartbeat(input: UpsertJobHeartbeatInput): Promise<void> {
  try {
    const now = new Date(input.startedAt.getTime() + input.durationMs);
    await db
      .insert(jobHeartbeats)
      .values({
        jobName: input.jobName,
        lastRunAt: now,
        lastSuccessAt: input.success ? now : null,
        lastDurationMs: input.durationMs,
        lastError: input.success ? null : (input.errorMessage ?? 'unknown error'),
      })
      .onConflictDoUpdate({
        target: jobHeartbeats.jobName,
        set: {
          lastRunAt: now,
          lastDurationMs: input.durationMs,
          // On success, update lastSuccessAt + clear last_error.
          // On failure, leave lastSuccessAt at its previous value so
          // the probe correctly measures the gap since last green.
          lastSuccessAt: input.success ? now : sql`job_heartbeats.last_success_at`,
          lastError: input.success ? null : (input.errorMessage ?? 'unknown error'),
          updatedAt: now,
        },
      });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[job-heartbeat] failed to upsert heartbeat for ${input.jobName}:`,
      err instanceof Error ? err.message : err
    );
  }
}
