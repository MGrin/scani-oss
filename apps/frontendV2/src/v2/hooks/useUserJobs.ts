import { useEffect } from 'react';
import { useRealtimeConnection } from '@/contexts/RealtimeContext';
import { type RouterOutputs, trpc } from '@/lib/trpc';

const ACTIVE_STATES = new Set(['queued', 'active', 'progress']);

// Action-required = job finished successfully, it's a type that
// produces extracted holdings the user still has to confirm, and the
// user hasn't stamped `action_taken_at` yet. These are the rows we want
// to nag the user about from the nav bar.
const ACTION_REQUIRED_JOB_NAMES = new Set(['screenshot-parse', 'file-import']);

export type UserJobRow = RouterOutputs['jobs']['listMine'][number];

export interface UseUserJobsResult {
  jobs: UserJobRow[];
  activeCount: number;
  actionRequiredCount: number;
  isLoading: boolean;
}

/**
 * Single source for "the user's job list" in the frontend.
 *
 * Caches the `jobs.listMine` tRPC query; subscribes to global job WS events
 * and invalidates the cache on every event so the badge + /jobs list feel
 * live without extra server plumbing. Multiple consumers (TopBar badge,
 * JobsPage, individual JobDetailPage) share the same cache entry.
 */
export function useUserJobs(): UseUserJobsResult {
  const { subscribeToAllJobsForUser } = useRealtimeConnection();
  const utils = trpc.useUtils();
  const query = trpc.jobs.listMine.useQuery(undefined, {
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });

  useEffect(() => {
    const unsubscribe = subscribeToAllJobsForUser(() => {
      void utils.jobs.listMine.invalidate();
    });
    return unsubscribe;
  }, [subscribeToAllJobsForUser, utils.jobs.listMine]);

  const jobs = query.data ?? [];
  const activeCount = jobs.reduce((acc, job) => acc + (ACTIVE_STATES.has(job.state) ? 1 : 0), 0);
  const actionRequiredCount = jobs.reduce(
    (acc, job) =>
      acc +
      (job.state === 'completed' && ACTION_REQUIRED_JOB_NAMES.has(job.jobName) && !job.actionTakenAt
        ? 1
        : 0),
    0
  );

  return { jobs, activeCount, actionRequiredCount, isLoading: query.isLoading };
}
