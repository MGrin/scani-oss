import { useEffect, useRef } from 'react';
import { useRealtimeConnection } from '@/contexts/RealtimeContext';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { foldRefreshBursts } from '../lib/jobs';

// Coalesce bursts of WS job events (progress ticks, state changes)
// into one `jobs.listMine` invalidate. The recompute flow can fire
// 4+ events in quick succession (one per phase: 0.05/0.55/0.95/1.0
// + state transitions) and each invalidate re-fetches the (still
// ~10 KB after the listMine trim, but multiplied across mounted
// hooks) list. 250ms is below human perception and well above the
// per-event burst window.
const INVALIDATE_DEBOUNCE_MS = 250;

const ACTIVE_STATES = new Set(['queued', 'active', 'progress']);

type UserJobRow = RouterOutputs['jobs']['listMine'][number];

export interface UseUserJobsResult {
  jobs: UserJobRow[];
  activeCount: number;
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

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsubscribe = subscribeToAllJobsForUser(() => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void utils.jobs.listMine.invalidate();
      }, INVALIDATE_DEBOUNCE_MS);
    });
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      unsubscribe();
    };
  }, [subscribeToAllJobsForUser, utils.jobs.listMine]);

  const jobs = query.data ?? [];
  // An app-open's refreshes count once, as the Jobs page lists them (SC-1724).
  const activeCount = foldRefreshBursts(jobs).reduce(
    (acc, job) => acc + (ACTIVE_STATES.has(job.state) ? 1 : 0),
    0
  );

  return {
    jobs,
    activeCount,
    isLoading: query.isLoading,
  };
}
