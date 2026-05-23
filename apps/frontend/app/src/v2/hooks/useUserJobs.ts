import { useEffect, useRef } from 'react';
import { useRealtimeConnection } from '@/contexts/RealtimeContext';
import { type RouterOutputs, trpc } from '@/lib/trpc';

// Coalesce bursts of WS job events (progress ticks, state changes)
// into one `jobs.listMine` invalidate. The recompute flow can fire
// 4+ events in quick succession (one per phase: 0.05/0.55/0.95/1.0
// + state transitions) and each invalidate re-fetches the (still
// ~10 KB after the listMine trim, but multiplied across mounted
// hooks) list. 250ms is below human perception and well above the
// per-event burst window.
const INVALIDATE_DEBOUNCE_MS = 250;

const ACTIVE_STATES = new Set(['queued', 'active', 'progress']);

// Action-required = job finished successfully, it's a type that
// produces holdings the user still has to confirm/prune, and the
// user hasn't stamped `action_taken_at` yet. `wallet-import` belongs
// here too: the worker writes holdings directly, but chain-sweep can
// pull in dust / scam tokens the user wants to drop before they start
// counting toward portfolio totals.
const ACTION_REQUIRED_JOB_NAMES = new Set(['screenshot-parse', 'file-import', 'wallet-import']);

// Jobs whose outcome can change the shape of the net-worth chart.
// While any of these are in flight the chart shows a loading
// overlay; if any of these recently failed the chart shows a
// warning banner so the user knows the curve is incomplete.
//
// `wallet-import` itself only writes the picker payload, no holdings,
// so it doesn't move the chart. The downstream `transaction-import`
// (driven by confirm) DOES, because BalanceAtTimeService needs the
// transaction ledger to compute past balances correctly.
const CHART_AFFECTING_JOB_NAMES = new Set([
  'transaction-import',
  'portfolio-history-backfill',
  'manual-holdings-create',
  'file-import',
  'screenshot-parse',
  'exchange-import',
  'holding-price-update',
]);

// "Recent" failure window for the chart warning banner. A failure
// older than this is assumed already-acted-on by the user (or
// orphaned by a prior session) and shouldn't poison the dashboard.
const RECENT_FAILURE_MS = 30 * 60 * 1000;

export type UserJobRow = RouterOutputs['jobs']['listMine'][number];

export interface UseUserJobsResult {
  jobs: UserJobRow[];
  activeCount: number;
  actionRequiredCount: number;
  // True when a job that can change the chart shape is queued/active/progress.
  chartAffectingActive: boolean;
  // Most recent failed chart-affecting job within RECENT_FAILURE_MS, if any.
  // Used by the chart warning banner.
  chartAffectingFailure: UserJobRow | null;
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
  const activeCount = jobs.reduce((acc, job) => acc + (ACTIVE_STATES.has(job.state) ? 1 : 0), 0);
  const actionRequiredCount = jobs.reduce(
    (acc, job) =>
      acc +
      (job.state === 'completed' && ACTION_REQUIRED_JOB_NAMES.has(job.jobName) && !job.actionTakenAt
        ? 1
        : 0),
    0
  );

  const chartAffectingActive = jobs.some(
    (job) => CHART_AFFECTING_JOB_NAMES.has(job.jobName) && ACTIVE_STATES.has(job.state)
  );

  const cutoff = Date.now() - RECENT_FAILURE_MS;
  let chartAffectingFailure: UserJobRow | null = null;
  for (const job of jobs) {
    if (job.state !== 'failed') continue;
    if (!CHART_AFFECTING_JOB_NAMES.has(job.jobName)) continue;
    const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : 0;
    if (finishedAt < cutoff) continue;
    // jobs are sorted desc by createdAt — first match is the most recent.
    chartAffectingFailure = job;
    break;
  }

  return {
    jobs,
    activeCount,
    actionRequiredCount,
    chartAffectingActive,
    chartAffectingFailure,
    isLoading: query.isLoading,
  };
}
