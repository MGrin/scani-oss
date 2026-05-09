import { Token } from 'typedi';

// Persisted record of every scheduled-job run. Used by the heartbeat
// probe to detect silent stoppages (worker crashed mid-deploy, advisory
// lock collisions, BullMQ scheduler glitch) — without this signal, a
// frozen `pricing` job goes unnoticed until users complain that
// portfolio values are stale.
//
// The interface lives here so `@scani/queue` doesn't depend on
// `@scani/db`. Concrete impl is registered at app boot from a layer
// that does have DB access (apps/backend/worker).
export interface JobRunOutcome {
  jobName: string;
  startedAt: Date;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
}

export abstract class JobHeartbeatWriter {
  abstract record(outcome: JobRunOutcome): Promise<void>;
}

export const JOB_HEARTBEAT_WRITER = new Token<JobHeartbeatWriter>('queue.job-heartbeat-writer');
