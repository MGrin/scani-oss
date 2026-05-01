/**
 * Job status tRPC router.
 *
 * The `user_jobs` DB table is the authoritative source for job state +
 * history — the backend's enqueue helper inserts a row before calling
 * `queue.add`, and the worker's processor wrapper writes through every
 * lifecycle transition (active / progress / completed / failed) before
 * publishing the WS event. Redis is the transport, not the record.
 *
 * `status` here merges: DB row (authoritative state + result + error) +
 * live BullMQ progress (only consulted while the row is non-terminal, so
 * the UI's progress bar stays smooth). For terminal states and evicted
 * jobs we never touch Redis — the DB is always complete.
 *
 * This router exists for two fallback cases vs. the preferred WS channel:
 *   1. WS is down / delayed — the frontend hook polls `jobs.status` every 2s.
 *   2. Page reload after a job was enqueued — the frontend looks up the
 *      jobId stored in local state to resume the modal.
 */

import { UserJobRepository } from '@scani/domain/repositories';
import { QueueClient } from '@scani/queue';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

const getQueue = () => Container.get(QueueClient).get();

const JOB_STATE_ENUM = z.enum(['queued', 'active', 'progress', 'completed', 'failed']);
const NON_TERMINAL = new Set(['queued', 'active', 'progress']);

export const jobsRouter = router({
  status: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const repo = Container.get(UserJobRepository);
      const row = await repo.findOneMine(ctx.userId, input.jobId);
      if (!row) return { state: 'not_found' as const };

      // Overlay live BullMQ progress on still-running jobs so the progress
      // bar reflects sub-second changes that haven't been mirrored to the
      // DB yet. Terminal-state jobs are served entirely from the DB; Redis
      // is never consulted for them (it may have evicted the job entirely).
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
        failedReason: row.error,
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
   */
  listMine: protectedProcedure
    .input(
      z
        .object({
          state: JOB_STATE_ENUM.optional(),
          limit: z.number().int().min(1).max(100).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(({ ctx, input }) => {
      const repo = Container.get(UserJobRepository);
      return repo.findMine(ctx.userId, input ?? {});
    }),

  /** Single job by id. Ownership-gated via `userId` column. */
  getMine: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const repo = Container.get(UserJobRepository);
      const row = await repo.findOneMine(ctx.userId, input.jobId);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Job not found' });
      return row;
    }),

  /**
   * One-shot stamp: "I took the follow-up action this job asked me to."
   * Called by review cards on screenshot-parse / file-import job detail
   * pages after a successful batch-create. Server-side idempotent (the
   * repo's `action_taken_at IS NULL` guard makes double-clicks a no-op),
   * so even with network retries we can't double-import the same
   * extracted holdings.
   */
  markActionTaken: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const repo = Container.get(UserJobRepository);
      const stamp = await repo.markActionTaken(ctx.userId, input.jobId);
      if (!stamp) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Job not found' });
      }
      return { actionTakenAt: stamp };
    }),

  /**
   * Re-run a failed job. Uses BullMQ's native `job.retry()` which resets
   * the attempts counter and moves the job back to the `waiting` set
   * with its original payload intact — no need for the backend to
   * reconstruct the full data from `payload_summary` (which is a
   * redacted allowlist, not the raw payload).
   *
   * Limitation: BullMQ only retains failed jobs up to `removeOnFail`
   * (currently 500). Older failures are evicted from Redis, so retry
   * is best-effort for recent failures only; we surface a clear 404
   * message when that happens so the UI can point the user at
   * re-triggering the originating action manually.
   */
  retry: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
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
      const job = await getQueue().getJob(input.jobId);
      if (!job) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message:
            'This job is too old to retry automatically. Re-trigger the original action from the UI.',
        });
      }
      try {
        await job.retry();
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
   *   active state". We fall back to `job.discard()` which prevents any
   *   further retries — the current attempt finishes whatever in-flight
   *   work it had, but the lifecycle write at the end of that attempt
   *   is a no-op because `markCompleted` / `markFailed` are now gated to
   *   skip already-terminal rows.
   *
   * Side effects already written by the running processor (DB rows it
   * inserted, R2 uploads it triggered) are not rolled back; cancellation
   * stops *further* progress and prevents retry, nothing else.
   */
  cancel: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
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
          try {
            await job.discard();
          } catch {
            // Discard on an already-completed/failed job is harmless;
            // swallow so the user-visible cancel succeeds either way.
          }
        }
      }

      return { ok: true as const };
    }),
});
