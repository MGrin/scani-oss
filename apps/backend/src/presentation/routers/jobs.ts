/**
 * Job status tRPC router.
 *
 * The primary status channel for user-initiated jobs is the WebSocket
 * `job` entity stream (see `RealTimeUpdatesService` + worker's
 * `publishJobEvent`). This router exists for two fallback cases:
 *
 *   1. WebSocket connection is down / delayed — the frontend hook polls
 *      `jobs.status` every 2s.
 *   2. Page reload after a job was enqueued — the frontend looks up the
 *      jobId stored in local state to resume the modal.
 *
 * We return only the minimal shape the frontend needs — state, progress,
 * returnvalue (result), failedReason (error).
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getQueue } from '../../queues/client';
import { protectedProcedure, router } from '../trpc';

export const jobsRouter = router({
  status: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const queue = getQueue();
      const job = await queue.getJob(input.jobId);
      if (!job) {
        return { state: 'not_found' as const };
      }
      // Default-deny ownership check. Every user-initiated payload carries
      // `userId` (see packages/core/src/queues/types.ts `UserJobBase`), so
      // the absence of a string userId means either (a) a scheduled cron
      // job (empty payload) or (b) a legacy/malformed entry. Either way
      // the caller has no legitimate reason to read it — without this
      // default-deny stance, `jobs.status` leaks cron job failedReason /
      // timestamps to any authenticated client.
      const payloadUserId =
        typeof job.data === 'object' && job.data !== null && 'userId' in job.data
          ? (job.data as { userId?: unknown }).userId
          : undefined;
      if (typeof payloadUserId !== 'string' || payloadUserId !== ctx.userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your job' });
      }
      const state = await job.getState();
      return {
        state,
        progress: typeof job.progress === 'number' ? job.progress : null,
        returnvalue: job.returnvalue ?? null,
        failedReason: job.failedReason ?? null,
        attemptsMade: job.attemptsMade,
        attemptsAllowed: job.opts.attempts ?? 1,
        timestamp: job.timestamp,
        processedOn: job.processedOn ?? null,
        finishedOn: job.finishedOn ?? null,
      };
    }),
});
