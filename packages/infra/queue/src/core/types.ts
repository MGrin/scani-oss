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
      /** Verbatim. Three admin surfaces read it; never shown to the owner. */
      error: string;
      /** The same failure in words written for the owner, or null if nobody
       *  wrote any — see `userFacing` in `./user-facing` (SC-551). */
      userFacingError: string | null;
      attemptsMade: number;
      attemptsAllowed: number;
    }
  /**
   * The queue has given up on this job (SC-153). Distinct from 'failed',
   * which fires on every failed *attempt* and says nothing about whether
   * another is coming.
   *
   * Fired by `WorkerClient` from BullMQ's own `failed` event rather than by
   * the processor, for two reasons: that is where terminality is already
   * decided (the same condition that pushes to the DLQ, so there is one
   * definition), and it catches failures the processor never saw — a payload
   * that fails validation throws before any lifecycle event is written, which
   * used to leave the mirror row sitting at 'queued' with nothing to correct
   * it.
   */
  | {
      type: 'dead';
      jobId: string;
      userId: string;
      jobName: string;
      error: string;
      userFacingError: string | null;
      attemptsMade: number;
      attemptsAllowed: number;
      reason: JobDeathReason;
    };

/**
 * Why the queue stopped trying. `unrecoverable` is BullMQ's
 * `UnrecoverableError` — a by-design failure the processor classified itself,
 * where the remaining attempts were deliberately skipped rather than used up.
 * Downstream vocabulary (`@scani/shared`) has more reasons than these two;
 * these are the only two the queue itself can observe.
 */
type JobDeathReason = 'retries_exhausted' | 'unrecoverable';

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
