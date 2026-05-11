import { cached } from '../../cache';
import { type Result, tryCatch } from '../../result';
import { getSql } from './sql';

export type UserJobState = 'queued' | 'active' | 'progress' | 'completed' | 'failed';

export interface UserJobsStats {
  total: number;
  /** Count per `state` enum. */
  byState: Record<UserJobState, number>;
  /** Top job names by total count (last 7 days). */
  byName: Array<{ name: string; count: number }>;
  /** Jobs that are `queued` or `active` longer than the reconciler window. */
  staleActive: Array<{
    jobId: string;
    jobName: string;
    state: UserJobState;
    createdAt: string;
    startedAt: string | null;
    attemptsMade: number;
  }>;
  /** Most recent N entries regardless of state. */
  recent: Array<{
    jobId: string;
    jobName: string;
    state: UserJobState;
    createdAt: string;
    finishedAt: string | null;
    attemptsMade: number;
    error: string | null;
  }>;
}

const ZERO_BY_STATE: Record<UserJobState, number> = {
  queued: 0,
  active: 0,
  progress: 0,
  completed: 0,
  failed: 0,
};

interface ByStateRow {
  state: UserJobState;
  count: string;
}

interface ByNameRow {
  job_name: string;
  count: string;
}

interface StaleRow {
  job_id: string;
  job_name: string;
  state: UserJobState;
  created_at: string;
  started_at: string | null;
  attempts_made: number | null;
}

interface RecentRow {
  job_id: string;
  job_name: string;
  state: UserJobState;
  created_at: string;
  finished_at: string | null;
  attempts_made: number | null;
  error: string | null;
}

export async function getUserJobsStats(): Promise<Result<UserJobsStats>> {
  return tryCatch(() =>
    cached('app-db:user-jobs-stats', 30, async () => {
      const db = await getSql();
      const [totalRow, byStateRows, byNameRows, staleRows, recentRows] = (await Promise.all([
        db`SELECT count(*)::text AS total FROM user_jobs`,
        db`
          SELECT state, count(*)::text AS count
          FROM user_jobs
          GROUP BY state
        `,
        db`
          SELECT job_name, count(*)::text AS count
          FROM user_jobs
          WHERE created_at > now() - interval '7 days'
          GROUP BY job_name
          ORDER BY count(*) DESC
          LIMIT 20
        `,
        db`
          SELECT job_id, job_name, state, created_at::text,
                 started_at::text, attempts_made
          FROM user_jobs
          WHERE state IN ('queued', 'active', 'progress')
            AND COALESCE(started_at, created_at) < now() - interval '15 minutes'
          ORDER BY created_at ASC
          LIMIT 25
        `,
        db`
          SELECT job_id, job_name, state, created_at::text,
                 finished_at::text, attempts_made, error
          FROM user_jobs
          ORDER BY created_at DESC
          LIMIT 25
        `,
      ])) as [Array<{ total: string }>, ByStateRow[], ByNameRow[], StaleRow[], RecentRow[]];

      const total = totalRow[0]?.total;
      if (total == null) throw new Error('user_jobs count query returned empty');

      const byState: Record<UserJobState, number> = { ...ZERO_BY_STATE };
      for (const r of byStateRows) {
        byState[r.state] = Number.parseInt(r.count, 10);
      }

      return {
        total: Number.parseInt(total, 10),
        byState,
        byName: byNameRows.map((r) => ({ name: r.job_name, count: Number.parseInt(r.count, 10) })),
        staleActive: staleRows.map((r) => ({
          jobId: r.job_id,
          jobName: r.job_name,
          state: r.state,
          createdAt: new Date(r.created_at).toISOString(),
          startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
          attemptsMade: r.attempts_made ?? 0,
        })),
        recent: recentRows.map((r) => ({
          jobId: r.job_id,
          jobName: r.job_name,
          state: r.state,
          createdAt: new Date(r.created_at).toISOString(),
          finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
          attemptsMade: r.attempts_made ?? 0,
          error: r.error,
        })),
      };
    })
  );
}
