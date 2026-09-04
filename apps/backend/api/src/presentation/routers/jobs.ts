/**
 * Job status tRPC router.
 *
 * The `user_jobs` DB table is the authoritative source for job state +
 * history — the backend's enqueue helper inserts a row before calling
 * `queue.add`, and the worker's processor wrapper writes through every
 * lifecycle transition (active / progress / completed / failed) before
 * publishing the WS event. The queue is the transport, not the record.
 *
 * `status` here merges: DB row (authoritative state + result + error) +
 * live BullMQ progress (only consulted while the row is non-terminal, so
 * the UI's progress bar stays smooth). For terminal states and evicted
 * jobs we never touch the queue — `user_jobs` is always complete.
 *
 * This router exists for two fallback cases vs. the preferred WS channel:
 *   1. WS is down / delayed — the frontend hook polls `jobs.status` every 2s.
 *   2. Page reload after a job was enqueued — the frontend looks up the
 *      jobId stored in local state to resume the modal.
 */

import type { UserJob } from '@scani/db/schema';
import { UserJobRepository } from '@scani/domain/repositories';
import { QueueClient } from '@scani/queue';
import { reviewOutcomeSchema } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

const getQueue = () => Container.get(QueueClient).get();

const JOB_STATE_ENUM = z.enum(['queued', 'active', 'progress', 'completed', 'failed']);
const NON_TERMINAL = new Set(['queued', 'active', 'progress']);

/** Why re-running is not on offer. Each one is a different sentence to the
 *  user, and "the queue no longer has it" is the one that must never be
 *  rendered as a working button. */
type RetryUnavailableReason =
  | 'not_failed'
  | 'cancelled'
  | 'never_delivered'
  | 'still_retrying'
  | 'evicted';

interface RetryAvailability {
  available: boolean;
  reason?: RetryUnavailableReason;
  /** Whether the queue still holds the job — the frontend reads this to tell a
   *  genuine pending retry from a row whose counters outlived the queue
   *  entry (`describeJobFailure` in @scani/shared). Undefined when the
   *  question was answered without a lookup. */
  queueHasJob?: boolean;
}

const RETRY_REFUSALS: Record<
  RetryUnavailableReason,
  { code: 'BAD_REQUEST' | 'NOT_FOUND'; message: string }
> = {
  not_failed: { code: 'BAD_REQUEST', message: 'Only failed jobs can be retried.' },
  cancelled: {
    code: 'BAD_REQUEST',
    message: 'You cancelled this job. Start it again from where you began it.',
  },
  never_delivered: {
    code: 'NOT_FOUND',
    message:
      'This job never reached the queue, so there is nothing to re-run. Start it again from where you began it.',
  },
  still_retrying: {
    code: 'BAD_REQUEST',
    message: 'This job is already queued for another attempt — no need to retry it.',
  },
  evicted: {
    code: 'NOT_FOUND',
    message:
      'This job is too old to re-run automatically — the queue no longer holds what it needs. Start it again from where you began it.',
  },
};

async function describeRetryAvailability(row: UserJob): Promise<RetryAvailability> {
  if (row.state !== 'failed') return { available: false, reason: 'not_failed' };
  // The user stopped it on purpose; re-running is a new action, not a repair.
  if (row.failureReason === 'cancelled') return { available: false, reason: 'cancelled' };
  // Never reached the queue, so there is no payload to replay — by definition,
  // not by lookup.
  if (row.failureReason === 'never_delivered') {
    return { available: false, reason: 'never_delivered' };
  }

  const job = await getQueue().getJob(row.jobId);
  if (!job) return { available: false, reason: 'evicted', queueHasJob: false };
  // `job.retry()` only accepts a job BullMQ itself considers failed. A row
  // that is `failed` from its last attempt while the queue is already
  // holding the next one is not a retry candidate — it is a job that is
  // about to run.
  const queueState = await job.getState();
  if (queueState !== 'failed') {
    return { available: false, reason: 'still_retrying', queueHasJob: true };
  }
  return { available: true, queueHasJob: true };
}

export const jobsRouter = router({
  status: protectedProcedure
    .input(strictInput(z.object({ jobId: z.string().min(1) })))
    .query(async ({ input, ctx }) => {
      const repo = Container.get(UserJobRepository);
      const row = await repo.findOneMine(ctx.userId, input.jobId);
      if (!row) return { state: 'not_found' as const };

      // Overlay live BullMQ progress on still-running jobs so the progress
      // bar reflects sub-second changes that haven't been mirrored to
      // `user_jobs` yet. Terminal-state jobs are served entirely from that
      // mirror; the queue is never consulted for them (it may have evicted
      // the job entirely).
      let liveProgress: number | null = null;
      if (NON_TERMINAL.has(row.state)) {
        const job = await getQueue().getJob(input.jobId);
        if (job && typeof job.progress === 'number') {
          liveProgress = job.progress;
        }
      }

      return {
        state: row.state,
        progress:
          liveProgress !== null && liveProgress > row.progress ? liveProgress : row.progress,
        returnvalue: row.result,
        // `row.userFacingError`, never `row.error` (SC-551). This procedure
        // answers the job's OWNER, and `error` is whatever the processor threw
        // — a `DrizzleQueryError` puts a full `select … from "holdings"` in it.
        // The raw column is untouched and still reaches the admin user-jobs
        // page, which is the surface that needs it.
        failedReason: row.userFacingError,
        attemptsMade: row.attemptsMade,
        attemptsAllowed: row.attemptsAllowed,
        timestamp: row.createdAt.getTime(),
        processedOn: row.startedAt?.getTime() ?? null,
        finishedOn: row.finishedAt?.getTime() ?? null,
      };
    }),

  /**
   * List the caller's jobs from the durable `user_jobs` mirror. Newest first.
   * Powers the top-nav badge count, the /jobs list page, and — via
   * `invalidate` on WS events — a near-live feed without extra server work.
   *
   * The full job `result` payload never arrives here: `findMine` leaves it
   * out of the SELECT (SC-155). It can be 258 KB for a large wallet import,
   * and the list view — badge count, jobs page row — renders none of it, so
   * per-job detail pages fetch the full row via `getMine` instead.
   *
   * This used to be a `.map` that dropped the field after the query had
   * already read it, which saved the wire bytes and none of the database
   * ones — on a query invalidated by every WS event during a recompute.
   */
  listMine: protectedProcedure
    .input(
      strictInput(
        z
          .object({
            state: JOB_STATE_ENUM.optional(),
            limit: z.number().int().min(1).max(100).default(50),
            offset: z.number().int().min(0).default(0),
          })
          .optional()
      )
    )
    .query(async ({ ctx, input }) => {
      const repo = Container.get(UserJobRepository);
      const rows = await repo.findMine(ctx.userId, input ?? {});
      // Same swap as `getMine`, and it matters even though no list component
      // renders the field: the raw text would still be in the JSON this
      // browser receives (SC-551). "Nothing displays it" is a claim about
      // today's components, not about what was disclosed.
      return rows.map(({ error: _raw, ...rest }) => rest);
    }),

  /**
   * Single job by id. Ownership-gated via `userId` column.
   *
   * Carries `retry`, which is the *honest* answer to "can this be re-run",
   * not a guess (SC-153). Retry needs the original payload, and `user_jobs`
   * only keeps a redacted `payload_summary` — the full data lives in the
   * BullMQ entry, which `removeOnFail` evicts. So the question can only be
   * answered by asking the queue, and a Retry button rendered without asking is
   * a button that silently fails for exactly the oldest, most-stuck jobs.
   * One lookup per detail-page open; deliberately not offered on the list,
   * where it would be one lookup per row.
   */
  getMine: protectedProcedure
    .input(strictInput(z.object({ jobId: z.string().min(1) })))
    .query(async ({ ctx, input }) => {
      const repo = Container.get(UserJobRepository);
      const row = await repo.findOneMine(ctx.userId, input.jobId);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Job not found' });
      // The spread would otherwise put the raw `error` on the wire, and
      // `JobDetailHeader` renders it as mono text on the owner's own
      // /jobs/<id> page — which is where the leaked SQL was actually seen
      // (SC-551). `userFacingError` is destructured out and re-emitted under
      // the name the client already reads, so only a vouched-for sentence
      // survives and nothing downstream had to learn a new field.
      const { error: _raw, ...rest } = row;
      return { ...rest, retry: await describeRetryAvailability(row) };
    }),

  /**
   * One-shot stamp: "I took the follow-up action this job asked me to."
   * Called by review cards on screenshot-parse / file-import job detail
   * pages after a successful batch-create. Server-side idempotent (the
   * repo's `action_taken_at IS NULL` guard makes double-clicks a no-op),
   * so even with network retries we can't double-import the same
   * extracted holdings.
   *
   * `outcome: 'discarded'` is the same stamp with the opposite meaning —
   * the user rejected the parse and nothing was written. It is the only
   * way out of the review queue that does not import (SC-138), and it is
   * recorded rather than inferred so the job page can say which happened.
   */
  markActionTaken: protectedProcedure
    .input(
      strictInput(
        z.object({
          jobId: z.string().min(1),
          outcome: reviewOutcomeSchema.default('imported'),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const repo = Container.get(UserJobRepository);
      const stamp = await repo.markActionTaken(ctx.userId, input.jobId, input.outcome);
      if (!stamp) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Job not found' });
      }
      return { actionTakenAt: stamp };
    }),

  /**
   * Re-run a failed job. Uses BullMQ's native `job.retry()`, which moves the
   * job back to the `waiting` set with its original payload intact — no need
   * for the backend to reconstruct the full data from `payload_summary`
   * (which is a redacted allowlist, not the raw payload).
   *
   * `resetAttemptsMade` is load-bearing and was missing (SC-167). BullMQ only
   * clears the counter when asked; the default carries it across, so a retry
   * of a job that had already spent its budget started at `attemptsMade` =
   * `attempts` and `shouldRetryJob` refused every further attempt. The retry
   * a user asked for got strictly fewer tries than the run they were
   * retrying — on `document-parse`, whose two attempts exist precisely
   * because the extractor is transiently flaky, that is the whole point of
   * the button gone. It also wrote `attempts_made` past `attempts_allowed`
   * (3 of 2 on mgrin's account), which reads as a job that ran an attempt it
   * was not entitled to and is really just an uncleared counter.
   *
   * Limitation: BullMQ only retains failed jobs up to `removeOnFail`
   * (currently 500). Older failures are evicted from the queue, so retry
   * is best-effort for recent failures only; we surface a clear 404
   * message when that happens so the UI can point the user at
   * re-triggering the originating action manually.
   */
  retry: protectedProcedure
    .input(strictInput(z.object({ jobId: z.string().min(1) })))
    .mutation(async ({ ctx, input }) => {
      const repo = Container.get(UserJobRepository);
      const row = await repo.findOneMine(ctx.userId, input.jobId);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Job not found' });
      if (row.state !== 'failed') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Only failed jobs can be retried; this job is ${row.state}.`,
        });
      }
      // Same check the UI used to decide whether to show the button, so the
      // two cannot disagree — and so a stale page says why rather than
      // appearing to work (SC-153).
      const availability = await describeRetryAvailability(row);
      if (!availability.available) {
        throw new TRPCError(RETRY_REFUSALS[availability.reason ?? 'evicted']);
      }
      const job = await getQueue().getJob(input.jobId);
      if (!job) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message:
            'This job is too old to retry automatically. Re-trigger the original action from the UI.',
        });
      }
      try {
        await job.retry('failed', { resetAttemptsMade: true });
      } catch (err) {
        // `job.retry()` throws if the job isn't in a retriable state
        // (e.g. someone else already retried it, or it was already
        // moved to `waiting`). Translate to a readable error.
        const msg = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg });
      }
      // Reset the mirror row so the /jobs UI reflects the re-queued
      // state immediately — the worker's processor-wrapper will flip it
      // to 'active' → 'completed' / 'failed' on the next attempt.
      await repo.markRequeued(input.jobId);
      return { ok: true as const };
    }),

  /**
   * Cancel a non-terminal job.
   *
   * Two-phase: lock the DB mirror first (state='failed' + actionTakenAt
   * stamped), then best-effort detach from BullMQ.
   *
   * - Queued/delayed jobs: `job.remove()` pulls them from the waiting
   *   set so the worker never picks them up.
   * - Active jobs: `job.remove()` errors with "cannot remove job in
   *   active state". BullMQ v6 removed `Job#discard()`, which used to be the
   *   fallback, and offers nothing to replace it — there is no longer any way
   *   to stop retries from outside the worker. So the stop now happens on the
   *   worker side instead: `markCancelled` above stamps
   *   `failure_reason = 'cancelled'`, and `UserJobProcessor` checks that
   *   before every attempt and throws `UnrecoverableError`.
   *
   *   That is strictly stronger than `discard()` was. `discard()` only
   *   prevented *further* retries and let the current attempt run to
   *   completion; the mirror check aborts the current attempt as well, so a
   *   cancelled `transaction-import` (`attempts: 4`) stops at the next
   *   processor entry rather than after up to four more runs of its side
   *   effects.
   *
   * Side effects already written by the running processor (DB rows it
   * inserted, R2 uploads it triggered) are not rolled back; cancellation
   * stops *further* progress and prevents retry, nothing else.
   */
  cancel: protectedProcedure
    .input(strictInput(z.object({ jobId: z.string().min(1) })))
    .mutation(async ({ ctx, input }) => {
      const repo = Container.get(UserJobRepository);
      const row = await repo.findOneMine(ctx.userId, input.jobId);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Job not found' });
      if (!NON_TERMINAL.has(row.state)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Job already ${row.state}; nothing to cancel.`,
        });
      }

      const ok = await repo.markCancelled(ctx.userId, input.jobId);
      if (!ok) {
        // Lost the race with the worker — the processor finished
        // between findOneMine and markCancelled.
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Job finished before cancellation took effect.',
        });
      }

      const job = await getQueue().getJob(input.jobId);
      if (job) {
        try {
          await job.remove();
        } catch {
          // Active — cannot be removed, and v6 has no `discard()`. The
          // cancellation is already durable (`markCancelled` above); the
          // worker enforces it on its next processor entry. Swallowing here
          // keeps the user-visible cancel succeeding either way, exactly as
          // before.
        }
      }

      return { ok: true as const };
    }),

  /**
   * Clear a failed job out of the user's list once they have decided not to
   * retry. The underlying BullMQ entry (if the queue still holds it) is
   * removed too, so it cannot be retried later.
   *
   * **The mirror row is kept, and stamped `dismissed_at` (SC-292).** This used
   * to delete it. Two `document-parse` failures on 2026-08-11 left four DLQ
   * entries and no row at all, which made "I never uploaded that"
   * indistinguishable from "I uploaded it and it failed" — and the user still
   * had the document. Dismissal is a refusal, and a refusal has to leave a
   * mark; the row is hidden from the listing, not destroyed.
   *
   * The name stays `remove` because that is what it does from the user's side
   * and the SPA already calls it.
   */
  remove: protectedProcedure
    .input(strictInput(z.object({ jobId: z.string().min(1) })))
    .mutation(async ({ ctx, input }) => {
      const repo = Container.get(UserJobRepository);
      const row = await repo.findOneMine(ctx.userId, input.jobId);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Job not found' });
      if (row.state !== 'failed') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Only failed jobs can be removed; this job is ${row.state}.`,
        });
      }
      const ok = await repo.dismissFailed(ctx.userId, input.jobId);
      if (!ok) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Job is no longer in failed state, or was already dismissed.',
        });
      }
      const job = await getQueue().getJob(input.jobId);
      if (job) {
        try {
          await job.remove();
        } catch {
          // Already evicted from the queue — DB row deletion is enough.
        }
      }
      return { ok: true as const };
    }),
});
