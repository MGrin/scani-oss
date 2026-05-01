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
  /**
   * Free-form phase message from inside the processor. Surfaced in the
   * UI so long-running waits (IBKR Flex generation, multi-chain wallet
   * detect, OCR pipeline) can show "Waiting for X — attempt 3/24"
   * instead of just an indeterminate bar. Optional; processors that
   * don't emit one keep the existing behaviour.
   */
  statusMessage?: string;
  result?: unknown;
  error?: string;
  attemptsMade?: number;
  attemptsAllowed?: number;
}

export type LifecycleEvent =
  | { type: 'active'; jobId: string; userId: string; jobName: string; attemptsMade: number }
  | {
      type: 'progress';
      jobId: string;
      userId: string;
      jobName: string;
      progress: number;
      statusMessage?: string;
    }
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
  /**
   * Push a phase / status message to the job's lifecycle stream without
   * advancing numeric progress. Used by long polls (IBKR Flex Query
   * generation, multi-chain wallet detect) to keep the user informed
   * during waits where percentage progress isn't meaningful.
   */
  reportStatus: (message: string) => Promise<void>;
}
