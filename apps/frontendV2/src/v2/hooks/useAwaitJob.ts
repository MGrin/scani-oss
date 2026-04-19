import { trpc } from '@/lib/trpc';

/**
 * Returns a callable `awaitJob(jobId)` that polls `jobs.status` until
 * the job reaches a terminal state (completed or failed), then resolves
 * with `{ ok, result, error }`. Uses the tRPC utils client so no
 * React hook rules are violated inside async flows.
 *
 * Pairs with the BullMQ async migration: the producer mutation returns a
 * jobId; callers that still want to show a result inline (e.g. review
 * screens after screenshot parsing) use this helper to wait for the
 * worker without bypassing BullMQ's retry/backoff logic.
 *
 * Prefer the `JobProgressModal` where the UX allows — this helper only
 * exists for flows that genuinely need the inline result.
 */
export function useAwaitJob(): (jobId: string) => Promise<{
  ok: boolean;
  result: unknown;
  error: string | null;
}> {
  const utils = trpc.useUtils();

  return async (jobId: string) => {
    const pollIntervalMs = 1_500;
    const maxWaitMs = 5 * 60 * 1_000;
    const start = Date.now();
    while (true) {
      if (Date.now() - start > maxWaitMs) {
        return { ok: false, result: null, error: 'Timed out waiting for job' };
      }
      try {
        const status = await utils.jobs.status.fetch({ jobId });
        if (status.state === 'not_found') {
          return { ok: false, result: null, error: 'Job not found' };
        }
        if (status.state === 'completed') {
          return { ok: true, result: status.returnvalue, error: null };
        }
        if (status.state === 'failed') {
          return { ok: false, result: null, error: status.failedReason ?? 'Job failed' };
        }
      } catch {
        // Transient network — try again.
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  };
}
