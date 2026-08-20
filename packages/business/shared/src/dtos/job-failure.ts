import { z } from 'zod';

/**
 * What a failed job's failure actually was (SC-153).
 *
 * `user_jobs.state = 'failed'` is written on every failed *attempt*, so on its
 * own it cannot separate a job that will retry in thirty seconds from one that
 * is permanently dead from one the user cancelled. All three rendered as the
 * same red chip, which made a dead import indistinguishable from a running one
 * — the interface reporting something reassuring about a state the system knew
 * was terminal.
 *
 * `user_jobs.dead_at` is the fact ("this will not run again"); this is the
 * reason, and the reason is what decides the sentence. "We tried three times"
 * and "we never handed it to the worker" are different situations with
 * different next steps, and telling someone to retry a job that was never
 * delivered wastes their time.
 */
export const USER_JOB_FAILURE_REASONS = [
  /** Every attempt ran and every attempt failed. */
  'retries_exhausted',
  /** Classified by-design failure (bad credentials, unsupported file) —
   *  BullMQ's `UnrecoverableError`. Retrying changes nothing on its own. */
  'unrecoverable',
  /** The mirror row was written but the job never reached Redis. It did not
   *  run, and nothing it would have touched was touched. */
  'never_delivered',
  /** The user stopped it. */
  'cancelled',
] as const;

export const userJobFailureReasonSchema = z.enum(USER_JOB_FAILURE_REASONS);

export type UserJobFailureReason = (typeof USER_JOB_FAILURE_REASONS)[number];

/**
 * `ReviewItem.kind` for a dead job. Like `DOCUMENT_EXTRACTION_REVIEW_KIND` and
 * `TRANSFER_REVIEW_KIND`, deliberately not a member of `REVIEWABLE_JOB_NAMES`:
 * that list gates "completed, and its result needs confirming". A dead job is
 * the opposite half — nothing completed, and what is waiting on the user is a
 * decision about a failure.
 */
export const DEAD_JOB_REVIEW_KIND = 'job-failed';

/** The row fields the description below reads. Structural so the server's
 *  `UserJob` and the frontend's `jobs.listMine` row both satisfy it. */
export interface JobFailureFacts {
  state: string;
  deadAt?: Date | string | null;
  failureReason?: string | null;
  attemptsMade?: number | null;
  attemptsAllowed?: number | null;
  /**
   * Whether the queue still holds this job. Only the server can answer it (one
   * Redis lookup), so it is optional — the list leaves it undefined and trusts
   * the counters.
   *
   * When it is explicitly `false`, the counters are stale: a row reading
   * "attempt 1 of 3" with nothing in the queue behind it is a worker that was
   * replaced mid-backoff, and promising that the next attempt "starts
   * automatically" is the same reassuring lie in a narrower window.
   */
  queueHasJob?: boolean;
}

/**
 * What the failure IS, as a code and its operands — never as a sentence.
 *
 * This package is the wire contract: `apps/backend/api` and the worker import
 * it, there is no `t()` on the server and there never will be, so a string
 * rendered here is a string no translator can reach. Every one of these used
 * to be English prose, and a Russian reader watching an import die was handed
 * "Failed — won't retry" in a language they did not choose, at the one moment
 * the interface has something urgent to say (SC-424).
 *
 * Same shape and same reason as `reviewLabelSchema` in `review.ts` (SC-371):
 * the server sends what the row is MADE OF, and the side that has a `t()`
 * names it. The operands are the numbers the sentence needs, carried as
 * numbers — a count that survives a round trip through prose is a count
 * waiting to be misread the first time the prose changes.
 */
export type JobFailureNaming =
  /** The user stopped it. */
  | { code: 'cancelled' }
  /** Never reached Redis: it did not run and changed nothing. */
  | { code: 'neverDelivered' }
  /** `UnrecoverableError` — another attempt on its own changes nothing. */
  | { code: 'unrecoverable' }
  /** Dead after more than one attempt, all of which failed. */
  | { code: 'exhausted'; attemptsAllowed: number }
  /** Dead, and only ever entitled to the one attempt. */
  | { code: 'noRetry' }
  /** Not dead, but the queue holds nothing for it. */
  | { code: 'notQueued' }
  /** A retry is genuinely coming. */
  | { code: 'retrying'; attemptsMade: number; attemptsAllowed: number }
  /** Out of attempts, not yet stamped dead — the gap between the two writes. */
  | { code: 'settling' };

export type JobFailureCode = JobFailureNaming['code'];

export type JobFailureDescription = JobFailureNaming & {
  /** Whether the queue will make another attempt without being asked. The
   *  single question the old red chip could not answer. */
  willRetry: boolean;
  /** Whether re-running it is a sensible thing to offer at all. False for a
   *  cancellation (the user meant it) — separate from whether the queue still
   *  holds the payload, which only the server can answer. */
  retryWorthOffering: boolean;
};

/**
 * The one description of a failure, shared by the server's review feed and both
 * frontends so a job cannot read "Retrying" on one surface and "Failed" on
 * another. Returns null for anything that has not failed.
 */
export function describeJobFailure(job: JobFailureFacts): JobFailureDescription | null {
  if (job.state !== 'failed') return null;

  const attemptsAllowed = job.attemptsAllowed ?? 1;
  const attemptsMade = job.attemptsMade ?? 0;

  if (job.deadAt) {
    switch (job.failureReason) {
      case 'cancelled':
        return { code: 'cancelled', willRetry: false, retryWorthOffering: false };
      case 'never_delivered':
        return { code: 'neverDelivered', willRetry: false, retryWorthOffering: true };
      case 'unrecoverable':
        return { code: 'unrecoverable', willRetry: false, retryWorthOffering: true };
      default:
        return attemptsAllowed > 1
          ? { code: 'exhausted', attemptsAllowed, willRetry: false, retryWorthOffering: true }
          : { code: 'noRetry', willRetry: false, retryWorthOffering: true };
    }
  }

  // Not dead, and the queue is known to have nothing for it. The row's
  // counters say a retry is due; the queue says otherwise, and the queue is
  // the one that would have to run it.
  if (job.queueHasJob === false) {
    return { code: 'notQueued', willRetry: false, retryWorthOffering: true };
  }

  // Not dead yet. A retry is genuinely coming — the row is `failed` because
  // the last attempt was, not because the job is over.
  if (attemptsMade > 0 && attemptsMade < attemptsAllowed) {
    return {
      code: 'retrying',
      attemptsMade,
      attemptsAllowed,
      willRetry: true,
      retryWorthOffering: false,
    };
  }

  // Out of attempts but not yet stamped dead: the worker writes the attempt
  // before the queue declares the job over, so this is the gap of a second or
  // two between them. Claiming a retry is coming would be the lie; claiming it
  // is permanently dead would be premature.
  return { code: 'settling', willRetry: false, retryWorthOffering: true };
}

/** Terminal *and* not yet dealt with — what the review feed asks about. */
export function isJobAwaitingFailureDecision(
  job: JobFailureFacts & { actionTakenAt?: Date | string | null }
): boolean {
  return Boolean(job.deadAt) && !job.actionTakenAt && job.failureReason !== 'cancelled';
}
