import type { Job } from 'bullmq';

// Every user-initiated job carries these. `userId` is the WS fan-out key
// for lifecycle events; `requestId` is a client-supplied UUID that feeds
// into the deterministic jobId so accidental double-clicks dedup natively
// in BullMQ.
export interface UserJobBase {
  userId: string;
  requestId: string;
}

export type JobLifecycleState = 'queued' | 'active' | 'progress' | 'completed' | 'failed';

export interface JobEventPayload {
  state: JobLifecycleState;
  progress?: number;
  result?: unknown;
  error?: string;
  attemptsMade?: number;
  attemptsAllowed?: number;
}

export type LifecycleEvent =
  | { type: 'active'; jobId: string; userId: string; jobName: string; attemptsMade: number }
  | { type: 'progress'; jobId: string; userId: string; jobName: string; progress: number }
  | { type: 'completed'; jobId: string; userId: string; jobName: string; result: unknown }
  | {
      type: 'failed';
      jobId: string;
      userId: string;
      jobName: string;
      error: string;
      attemptsMade: number;
      attemptsAllowed: number;
    };

export interface EnqueuedJobMeta {
  jobId: string;
  userId: string;
  jobName: string;
  payloadSummary: Record<string, unknown>;
  attemptsAllowed: number;
}

export interface ProcessorContext {
  job: Job;
  reportProgress: (progress: number) => Promise<void>;
}
