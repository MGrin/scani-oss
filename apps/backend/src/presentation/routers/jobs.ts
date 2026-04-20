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
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { getQueue } from '../../queues/client';
import { protectedProcedure, router } from '../trpc';

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
});
